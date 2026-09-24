import { z } from 'zod';
import type { V2ClientPackage } from '../contracts/launch';
import { emptyRuntimeDomains, runtimeDomainsSchema } from './state-domains';

export const SECONDS_PER_DAY = 86_400;
export const DEFAULT_START_SECOND_OF_DAY = 8 * 3600;
export type DayPhase = 'late_night' | 'pre_dawn' | 'dawn' | 'morning' | 'midday' | 'afternoon' | 'dusk' | 'evening' | 'night';

export const actorSchema = z.object({
  id: z.string(), name: z.string(), role: z.enum(['player', 'character']),
  locationId: z.string().nullable(), knowledge: z.array(z.string().max(4000)).max(100),
});
export const worldSchema = z.object({
  revision: z.number().int().nonnegative(),
  elapsedSeconds: z.number().int().nonnegative().safe(),
  simulationDay: z.number().int().positive().safe().default(1),
  timeOfDaySeconds: z.number().int().min(0).max(SECONDS_PER_DAY - 1).default(DEFAULT_START_SECOND_OF_DAY),
  locationId: z.string().nullable(), actors: z.array(actorSchema).max(200),
  domains: runtimeDomainsSchema.default(emptyRuntimeDomains()),
});
export type WorldState = z.infer<typeof worldSchema>;
export type WorldAction =
  | { type: 'set-scene'; locationId: string; presentActorIds: string[] }
  | { type: 'advance-clock'; seconds: number }
  | { type: 'travel'; actorId: string; locationId: string; seconds: number }
  | { type: 'record-knowledge'; actorId: string; fact: string }
  | { type: 'inventory-add'; instanceId: string; canonicalItemId: string; ownerActorId: string | null; quantity: number; equipped: boolean; condition?: number | null }
  | { type: 'inventory-set-equipped'; instanceId: string; equipped: boolean }
  | { type: 'inventory-remove'; instanceId: string };

export function assetsFor(launch: V2ClientPackage) {
  return [launch.primaryAsset, ...launch.relatedAssets];
}

function dayPhaseAt(secondOfDay: number): DayPhase {
  const hour = secondOfDay / 3600;
  if (hour < 4) return 'late_night';
  if (hour < 5.5) return 'pre_dawn';
  if (hour < 7) return 'dawn';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17.5) return 'afternoon';
  if (hour < 19) return 'dusk';
  if (hour < 20) return 'evening';
  return 'night';
}

export function worldClock(world: Pick<WorldState, 'simulationDay' | 'timeOfDaySeconds'>) {
  const hours = Math.floor(world.timeOfDaySeconds / 3600);
  const minutes = Math.floor((world.timeOfDaySeconds % 3600) / 60);
  return {
    simulationDay: world.simulationDay,
    timeOfDaySeconds: world.timeOfDaySeconds,
    time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    phase: dayPhaseAt(world.timeOfDaySeconds),
    isNight: world.timeOfDaySeconds >= 20 * 3600 || world.timeOfDaySeconds < 5.5 * 3600,
  };
}

function advanceWorldClock(next: WorldState, seconds: number) {
  const total = next.timeOfDaySeconds + seconds;
  next.elapsedSeconds += seconds;
  next.simulationDay += Math.floor(total / SECONDS_PER_DAY);
  next.timeOfDaySeconds = total % SECONDS_PER_DAY;
}

function assertPlace(locationId: string, launch: V2ClientPackage) {
  if (!assetsFor(launch).some((asset) => asset.id === locationId && asset.type === 'place')) {
    throw new Error('Location must be a canonical place supplied by Orbis.');
  }
}

function assertItem(itemId: string, launch: V2ClientPackage) {
  if (!assetsFor(launch).some((asset) => asset.id === itemId && asset.type === 'item')) {
    throw new Error('Inventory items must reference canonical items supplied by Orbis.');
  }
}

function assertInventoryOwner(ownerActorId: string | null, world: WorldState) {
  if (ownerActorId !== null && !world.actors.some((actor) => actor.id === ownerActorId)) {
    throw new Error('Inventory owner must be a packaged actor or unowned.');
  }
}

function sourceIdOf(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const sourceId = (data as Record<string, unknown>).sourceId;
  return typeof sourceId === 'string' ? sourceId.trim().toLowerCase() : null;
}

function initialLocationFor(launch: V2ClientPackage) {
  if (launch.primaryAsset.type === 'place') return launch.primaryAsset.id;
  if (launch.initialLocationId) return launch.initialLocationId;

  // Compatibility fallback for launch packages created before Orbis began
  // emitting initialLocationId. The fallback can only anchor to a place that
  // is already packaged, so it never invents or reaches outside launch canon.
  const assets = assetsFor(launch);
  const isBitterroot = assets.some((asset) => asset.type === 'world' && asset.name.trim().toLowerCase() === 'bitterroot');
  if (!isBitterroot) return null;
  const hollowmere = assets.find((asset) => asset.type === 'place'
    && (asset.name.trim().toLowerCase() === 'hollowmere' || sourceIdOf(asset.data) === 'hollowmere'));
  return hollowmere?.id ?? null;
}

export function createWorld(launch: V2ClientPackage): WorldState {
  const locationId = initialLocationFor(launch);
  const packagedCharacters = [...new Map(
    assetsFor(launch)
      .filter((asset) => asset.type === 'character')
      .map((asset) => [asset.id, asset] as const),
  ).values()];
  return {
    revision: 0, elapsedSeconds: 0, simulationDay: 1, timeOfDaySeconds: DEFAULT_START_SECOND_OF_DAY, locationId,
    actors: [
      { id: launch.persona.id, name: launch.persona.name, role: 'player', locationId, knowledge: [] },
      ...packagedCharacters.map((asset) => ({
        id: asset.id,
        name: asset.name,
        role: 'character' as const,
        locationId: null,
        knowledge: [],
      })),
    ],
    domains: emptyRuntimeDomains(),
  };
}

// Explicit operator assertions and narrow trusted resolver effects, not generated world patches.
export function applyWorldAction(world: WorldState, action: WorldAction, launch: V2ClientPackage): WorldState {
  const next = structuredClone(world);
  if (action.type === 'set-scene') {
    assertPlace(action.locationId, launch);
    if (!action.presentActorIds.includes(launch.persona.id)
      || action.presentActorIds.some((id) => !next.actors.some((actor) => actor.id === id))) {
      throw new Error('Scene presence must include the player and only packaged actors.');
    }
    next.locationId = action.locationId;
    for (const actor of next.actors) actor.locationId = action.presentActorIds.includes(actor.id) ? action.locationId : null;
  } else if (action.type === 'advance-clock') {
    if (!Number.isSafeInteger(action.seconds) || action.seconds <= 0 || action.seconds > SECONDS_PER_DAY) {
      throw new Error('Advance the clock by 1 to 86400 whole seconds.');
    }
    advanceWorldClock(next, action.seconds);
  } else if (action.type === 'travel') {
    if (!Number.isSafeInteger(action.seconds) || action.seconds <= 0 || action.seconds > 7 * SECONDS_PER_DAY) {
      throw new Error('Travel time must be 1 second to 7 days.');
    }
    assertPlace(action.locationId, launch);
    const actor = next.actors.find((candidate) => candidate.id === action.actorId);
    if (!actor) throw new Error('Travel requires an existing actor.');
    advanceWorldClock(next, action.seconds);
    actor.locationId = action.locationId;
    if (actor.role === 'player') next.locationId = action.locationId;
  } else if (action.type === 'record-knowledge') {
    const actor = next.actors.find((candidate) => candidate.id === action.actorId);
    if (!actor || !action.fact.trim()) throw new Error('An existing actor and an explicit observed fact are required.');
    actor.knowledge = [...new Set([...actor.knowledge, action.fact.trim()])];
  } else if (action.type === 'inventory-add') {
    assertItem(action.canonicalItemId, launch);
    assertInventoryOwner(action.ownerActorId, next);
    if (!action.instanceId.trim() || next.domains.inventory.some((item) => item.instanceId === action.instanceId)) {
      throw new Error('Inventory instance identity must be unique.');
    }
    if (!Number.isSafeInteger(action.quantity) || action.quantity <= 0 || action.quantity > 1_000_000) {
      throw new Error('Inventory quantity must be a whole number between 1 and 1000000.');
    }
    const condition = action.condition ?? null;
    if (condition !== null && (!Number.isFinite(condition) || condition < 0 || condition > 1)) {
      throw new Error('Inventory condition must be between 0 and 1 or unset.');
    }
    next.domains.inventory.push({
      instanceId: action.instanceId,
      canonicalItemId: action.canonicalItemId,
      ownerActorId: action.ownerActorId,
      containerId: null,
      quantity: action.quantity,
      equipped: action.equipped,
      condition,
    });
  } else if (action.type === 'inventory-set-equipped') {
    const item = next.domains.inventory.find((candidate) => candidate.instanceId === action.instanceId);
    if (!item) throw new Error('Inventory instance does not exist.');
    item.equipped = action.equipped;
  } else {
    const before = next.domains.inventory.length;
    next.domains.inventory = next.domains.inventory.filter((item) => item.instanceId !== action.instanceId);
    if (next.domains.inventory.length === before) throw new Error('Inventory instance does not exist.');
  }
  next.revision += 1;
  return worldSchema.parse(next);
}

export function assertWorldCanon(world: WorldState, launch: V2ClientPackage): void {
  const places = new Set(assetsFor(launch).filter((asset) => asset.type === 'place').map((asset) => asset.id));
  const expectedActors = createWorld(launch).actors;
  if (world.locationId && !places.has(world.locationId)) throw new Error('World state references an unpackaged place.');
  if (world.actors.length !== expectedActors.length || new Set(world.actors.map((actor) => actor.id)).size !== world.actors.length
    || world.actors.some((actor) => !expectedActors.some((expected) => expected.id === actor.id && expected.name === actor.name && expected.role === actor.role)
      || (actor.locationId !== null && !places.has(actor.locationId)))) {
    throw new Error('World state does not match the packaged actors and places.');
  }
  const itemIds = new Set(assetsFor(launch).filter((asset) => asset.type === 'item').map((asset) => asset.id));
  const actorIds = new Set(world.actors.map((actor) => actor.id));
  if (world.domains.inventory.some((item) => !itemIds.has(item.canonicalItemId)
    || (item.ownerActorId !== null && !actorIds.has(item.ownerActorId)))) {
    throw new Error('World inventory references an unpackaged item or actor.');
  }
}

export function perceptionFor(world: WorldState, actorId: string) {
  const actor = world.actors.find((value) => value.id === actorId);
  const anchored = Boolean(actor?.locationId);
  return {
    locationId: actor?.locationId ?? null,
    presentActors: actor?.locationId ? world.actors.filter((value) => value.locationId === actor.locationId).map(({ id, name }) => ({ id, name })) : [],
    knownFacts: actor?.knowledge ?? [],
    limitations: [
      anchored ? 'Presence is limited to actors explicitly anchored at the current location.' : 'Presence is unknown until explicitly anchored.',
      'Related canon is not automatically character knowledge.',
    ],
  };
}
