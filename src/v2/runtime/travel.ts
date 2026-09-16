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
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MOTION = /\b(?:go|going|went|walk|walking|walked|head|heading|headed|travel|travelling|traveling|travelled|traveled|ride|riding|rode|journey|journeying|return|returning|returned|leave|leaving|left|move|moving|moved|enter|entering|entered|approach|approaching|approached)\b/i;
const TELEPORT = /\b(?:teleport|teleporting|teleported|warp|warping|warped|blink|blinking|blinked)\b/i;

function documentFor(launch: V2ClientPackage, assetId: string, data: unknown) {
  const direct = asRecord(data);
  if (Object.keys(direct).length) return direct;
  const block = launch.contextBlocks.find((value) => value.id === assetId);
  if (!block) return {};
  try { return asRecord(JSON.parse(block.content)); }
  catch { return {}; }
}

function sourceIdentity(launch: V2ClientPackage, assetId: string, data: unknown) {
  const document = documentFor(launch, assetId, data);
  return {
    sourceId: typeof document.sourceId === 'string' ? document.sourceId : assetId,
    parentLocationId: typeof document.parentLocationId === 'string' ? document.parentLocationId : null,
    distanceKm: (() => {
      const travel = asRecord(document.travelFromHollowmere);
      return typeof travel.distanceFromHollowmereKm === 'number' && Number.isFinite(travel.distanceFromHollowmereKm)
        ? travel.distanceFromHollowmereKm
        : null;
    })(),
  };
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
  const destination = places.find((asset) => {
    const match = new RegExp(`\\b${escapeRegExp(asset.name)}\\b`, 'i').exec(text);
    if (!match) return false;
    const before = text.slice(Math.max(0, match.index - 120), match.index);
    return MOTION.test(before) || TELEPORT.test(before);
  });
  if (!destination) return { kind: 'none' };
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
    || destinationRef.parentLocationId === originRef.sourceId
    || (originRef.parentLocationId && originRef.parentLocationId === destinationRef.parentLocationId);
  if (relatedLocally) {
    distanceKm = 1;
    routeBasis = 'local';
  } else if (originRef.distanceKm !== null && destinationRef.distanceKm !== null) {
    if (originRef.distanceKm === 0 || destinationRef.distanceKm === 0) {
      distanceKm = Math.max(originRef.distanceKm, destinationRef.distanceKm);
      routeBasis = 'direct-reference';
    } else {
      distanceKm = originRef.distanceKm + destinationRef.distanceKm;
      routeBasis = 'via-hollowmere';
    }
  }

  if (distanceKm === null) {
    return {
      kind: 'deferred',
      reason: `Travel to ${destination.name} is canonical, but no authoritative route distance is packaged for both endpoints.`,
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
