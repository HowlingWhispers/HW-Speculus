import type { V2ClientPackage } from '../contracts/launch';
import type { WorldState } from './world';
import { assetsFor } from './world';

export type TravelMode = 'onFoot' | 'mounted' | 'cart';
export type TravelResult =
  | { kind: 'none' }
  | { kind: 'deferred'; reason: string; destinationId?: string; destinationName?: string }
  | {
    kind: 'resolved';
    originId: string;
    originName: string;
    destinationId: string;
    destinationName: string;
    distanceKm: number;
    seconds: number;
    mode: TravelMode;
    routeBasis: 'direct-reference' | 'local' | 'via-hollowmere';
  };

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const MOTION = /\b(?:go|going|went|walk|walking|walked|head|heading|headed|travel|travelling|traveling|travelled|traveled|ride|riding|rode|journey|journeying|return|returning|returned|leave|leaving|left|move|moving|moved|enter|entering|entered|approach|approaching|approached)\b/i;
const DESTINATION_LINK = /\b(?:to|toward|towards|into|onto|back\s+to)\b/i;
const TELEPORT = /\b(?:teleport|teleporting|teleported|warp|warping|warped|blink|blinking|blinked)\b/i;
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'at', 'on', 'to', 'from']);

type PlaceAsset = ReturnType<typeof assetsFor>[number];

function documentFor(launch: V2ClientPackage, assetId: string, data: unknown) {
  const direct = asRecord(data);
  const block = launch.contextBlocks.find((value) => value.id === assetId);
  let contextual: Record<string, unknown> = {};
  if (block) {
    try { contextual = asRecord(JSON.parse(block.content)); }
    catch { contextual = {}; }
  }
  return { ...contextual, ...direct };
}

function sourceIdentity(launch: V2ClientPackage, assetId: string, data: unknown) {
  const document = documentFor(launch, assetId, data);
  const sourceId = typeof document.sourceId === 'string'
    ? document.sourceId
    : typeof document.id === 'string'
      ? document.id
      : assetId;
  return {
    sourceId,
    parentLocationId: typeof document.parentLocationId === 'string' ? document.parentLocationId : null,
    distanceKm: (() => {
      const travel = asRecord(document.travelFromHollowmere);
      return typeof travel.distanceFromHollowmereKm === 'number' && Number.isFinite(travel.distanceFromHollowmereKm)
        ? travel.distanceFromHollowmereKm
        : null;
    })(),
  };
}

function normalizeWords(value: string) {
  return value.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function significantWords(value: string) {
  return normalizeWords(value).split(/\s+/).filter((word) => word && !STOP_WORDS.has(word));
}

function containsPhrase(text: string, phrase: string) {
  const normalizedPhrase = normalizeWords(phrase);
  return Boolean(normalizedPhrase) && ` ${normalizeWords(text)} `.includes(` ${normalizedPhrase} `);
}

function placeByIdentity(launch: V2ClientPackage, places: PlaceAsset[], identity: string | null) {
  if (!identity) return undefined;
  const wanted = identity.trim().toLowerCase();
  return places.find((place) => place.id.toLowerCase() === wanted
    || sourceIdentity(launch, place.id, place.data).sourceId.trim().toLowerCase() === wanted);
}

function inheritedDistanceFromHollowmere(
  launch: V2ClientPackage,
  places: PlaceAsset[],
  place: PlaceAsset,
  visited = new Set<string>(),
): number | null {
  if (visited.has(place.id)) return null;
  visited.add(place.id);
  const identity = sourceIdentity(launch, place.id, place.data);
  if (identity.distanceKm !== null) return identity.distanceKm;
  const parent = placeByIdentity(launch, places, identity.parentLocationId);
  return parent ? inheritedDistanceFromHollowmere(launch, places, parent, visited) : null;
}

function shortPlaceName(launch: V2ClientPackage, places: PlaceAsset[], place: PlaceAsset) {
  const identity = sourceIdentity(launch, place.id, place.data);
  const parent = placeByIdentity(launch, places, identity.parentLocationId);
  if (!parent) return null;
  const full = normalizeWords(place.name);
  const parentName = normalizeWords(parent.name);
  if (full.startsWith(`${parentName} `)) return full.slice(parentName.length + 1).trim() || null;
  if (full.endsWith(` ${parentName}`)) return full.slice(0, -(parentName.length + 1)).trim() || null;
  return null;
}

function destinationFor(launch: V2ClientPackage, places: PlaceAsset[], text: string) {
  const normalizedText = normalizeWords(text);
  const normalizedTextWords = normalizedText.split(/\s+/);
  const shortNames = places.map((place) => shortPlaceName(launch, places, place));
  const shortNameCounts = new Map<string, number>();
  for (const name of shortNames) if (name) shortNameCounts.set(name, (shortNameCounts.get(name) ?? 0) + 1);

  const scored = places.map((place, index) => {
    const identity = sourceIdentity(launch, place.id, place.data);
    const fullName = normalizeWords(place.name);
    const sourceName = normalizeWords(identity.sourceId);
    const parent = placeByIdentity(launch, places, identity.parentLocationId);
    const parentMentioned = parent ? containsPhrase(normalizedText, parent.name) : false;
    let score = 0;

    if (containsPhrase(normalizedText, fullName)) score = 1000 + fullName.length;
    if (sourceName && sourceName !== normalizeWords(place.id) && containsPhrase(normalizedText, sourceName)) {
      score = Math.max(score, 950 + sourceName.length);
    }

    const words = significantWords(place.name);
    if (words.length >= 2 && words.every((word) => normalizedTextWords.includes(word))) {
      // All meaningful words naming a nested place can appear in natural speech
      // in a different order, e.g. "Ranger Station in Brackenjaw enclave".
      // Prefer that complete, more-specific match over the parent settlement.
      score = Math.max(score, 1200 + words.length * 10 + fullName.length);
    }

    const shortName = shortNames[index];
    if (shortName && containsPhrase(normalizedText, shortName)
      && (parentMentioned || shortNameCounts.get(shortName) === 1)) {
      score = Math.max(score, (parentMentioned ? 900 : 700) + shortName.length);
    }

    return { place, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.place.name.length - a.place.name.length);

  if (!scored.length) return { place: undefined, ambiguous: false };
  const top = scored[0];
  const tied = scored.filter((entry) => entry.score === top.score);
  return { place: tied.length === 1 ? top.place : undefined, ambiguous: tied.length > 1 };
}

function modeFrom(text: string): TravelMode {
  if (/\b(?:cart|wagon|carriage)\b/i.test(text)) return 'cart';
  if (/\b(?:ride|riding|rode|horse|mount|mounted|saddle)\b/i.test(text)) return 'mounted';
  return 'onFoot';
}

function speedFor(mode: TravelMode) {
  return mode === 'mounted' ? 6 : mode === 'cart' ? 3 : 4;
}

export function resolveTravelIntent(launch: V2ClientPackage, world: WorldState, player: string): TravelResult {
  const text = player.trim();
  if (!text) return { kind: 'none' };
  const teleporting = TELEPORT.test(text);
  if (!teleporting && !MOTION.test(text)) return { kind: 'none' };

  const places = assetsFor(launch).filter((asset) => asset.type === 'place').sort((a, b) => b.name.length - a.name.length);
  const destinationMatch = destinationFor(launch, places, text);
  const destination = destinationMatch.place;
  if (!destination) {
    if (destinationMatch.ambiguous) {
      return { kind: 'deferred', reason: 'The travel destination is ambiguous among packaged canonical places. Name the settlement, region, or building more specifically.' };
    }
    if (DESTINATION_LINK.test(text) || /^\s*\*?\s*(?:travel|journey|return|head|go)\b/i.test(text)) {
      return { kind: 'deferred', reason: 'The requested travel destination could not be matched to a canonical place packaged by Orbis.' };
    }
    return { kind: 'none' };
  }
  if (teleporting) return { kind: 'deferred', reason: 'Teleportation is not authorized by the packaged world state.', destinationId: destination.id, destinationName: destination.name };
  if (!world.locationId) return { kind: 'deferred', reason: `Travel to ${destination.name} cannot resolve because the player has no confirmed origin location.`, destinationId: destination.id, destinationName: destination.name };
  if (world.locationId === destination.id) return { kind: 'none' };

  const origin = places.find((asset) => asset.id === world.locationId);
  if (!origin) return { kind: 'deferred', reason: 'The confirmed origin is not a packaged canonical place.', destinationId: destination.id, destinationName: destination.name };

  const originRef = sourceIdentity(launch, origin.id, origin.data);
  const destinationRef = sourceIdentity(launch, destination.id, destination.data);
  let distanceKm: number | null = null;
  let routeBasis: 'direct-reference' | 'local' | 'via-hollowmere' = 'via-hollowmere';

  const relatedLocally = originRef.parentLocationId === destinationRef.sourceId
    || originRef.parentLocationId === destination.id
    || destinationRef.parentLocationId === originRef.sourceId
    || destinationRef.parentLocationId === origin.id
    || (originRef.parentLocationId && originRef.parentLocationId === destinationRef.parentLocationId);
  if (relatedLocally) {
    distanceKm = 1;
    routeBasis = 'local';
  } else {
    const originDistanceKm = inheritedDistanceFromHollowmere(launch, places, origin);
    const destinationDistanceKm = inheritedDistanceFromHollowmere(launch, places, destination);
    if (originDistanceKm !== null && destinationDistanceKm !== null) {
      if (originDistanceKm === 0 || destinationDistanceKm === 0) {
        distanceKm = Math.max(originDistanceKm, destinationDistanceKm);
        routeBasis = 'direct-reference';
      } else {
        distanceKm = originDistanceKm + destinationDistanceKm;
        routeBasis = 'via-hollowmere';
      }
    }
  }

  if (distanceKm === null) {
    return {
      kind: 'deferred',
      reason: `Travel to ${destination.name} is canonical, but no authoritative route distance is packaged for the destination or one of its parent locations.`,
      destinationId: destination.id,
      destinationName: destination.name,
    };
  }

  const mode = modeFrom(text);
  const seconds = Math.max(5 * 60, Math.round((distanceKm / speedFor(mode)) * 3600));
  if (seconds > 7 * 86_400) {
    return { kind: 'deferred', reason: `Travel to ${destination.name} exceeds the current seven-day resolver window.`, destinationId: destination.id, destinationName: destination.name };
  }
  return {
    kind: 'resolved',
    originId: origin.id,
    originName: origin.name,
    destinationId: destination.id,
    destinationName: destination.name,
    distanceKm,
    seconds,
    mode,
    routeBasis,
  };
}
