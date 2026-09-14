import { z } from 'zod';
import { v2StoredPackageSchema, type V2ClientPackage } from '../contracts/launch';
import { eventSchema, settingsSchema, turnSchema, type V2Session } from '../runtime/session';
import { assertWorldCanon, assetsFor, createWorld, worldSchema } from '../runtime/world';

export const V2_STORAGE_KEY = 'speculus.session.v2';
export const V2_EXPORT_FORMAT = 'speculus-v2-session';
export const MAX_V2_FILE_BYTES = 16 * 1024 * 1024;
const stateSchema = z.object({
  version: z.literal(2), engine: z.literal('v2'), world: worldSchema,
  settings: settingsSchema, draft: z.string().max(16000), turns: z.array(turnSchema).max(20000),
  events: z.array(eventSchema).max(40000), nextTurn: z.number().int().positive(),
});
const identitySchema = z.object({ id: z.string(), revision: z.string(), name: z.string() });
const sourceSchema = z.object({
  id: z.string(), type: z.string(), revision: z.string(), name: z.string().optional(),
  world: identitySchema.nullable().optional(),
  location: identitySchema.nullable().optional(),
  persona: z.object({ id: z.string(), name: z.string() }).optional(),
  character: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  exportedAt: z.number().int().positive().optional(),
  elapsedSeconds: z.number().int().nonnegative().optional(),
});
const transferSchema = stateSchema.extend({ format: z.literal(V2_EXPORT_FORMAT), source: sourceSchema });

function validateState(state: z.infer<typeof stateSchema>, launch: V2ClientPackage) {
  assertWorldCanon(state.world, launch);
  const ids = new Set(state.turns.map((turn) => turn.id));
  const turnsById = new Map(state.turns.map((turn) => [turn.id, turn]));
  if (ids.size !== state.turns.length || state.nextTurn <= state.turns.length) throw new Error('Invalid V2 turn identity or counter.');
  if (new Set(state.events.map((event) => event.id)).size !== state.events.length) throw new Error('V2 ledger has duplicate event identities.');
  for (const turn of state.turns) {
    const ordinal = Number(turn.id.match(/:([1-9][0-9]*)$/)?.[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal >= state.nextTurn) throw new Error('V2 turn counter would reuse an existing identity.');
  }
  const turnEvents = state.events.filter((event) => event.kind === 'turn');
  if (turnEvents.length !== ids.size || new Set(turnEvents.map((event) => event.id)).size !== ids.size
    || turnEvents.some((event) => !ids.has(event.id))) throw new Error('V2 event ledger does not match its turns.');
  let replay = createWorld(launch);
  for (const event of state.events) {
    if (event.kind === 'operator') {
      if (!event.world || event.worldRevision !== replay.revision + 1 || event.world.revision !== event.worldRevision
        || event.world.elapsedSeconds < replay.elapsedSeconds) throw new Error('V2 operator ledger has inconsistent world revisions.');
      assertWorldCanon(event.world, launch); replay = event.world;
    } else {
      const turn = turnsById.get(event.id)!;
      if (event.worldRevision !== replay.revision || turn.worldRevision !== replay.revision || turn.diagnostics.worldRevision !== replay.revision) {
        throw new Error('V2 turn references an inconsistent world revision.');
      }
    }
  }
  if (JSON.stringify(replay) !== JSON.stringify(state.world)) throw new Error('V2 world state does not match its operator ledger.');
}

function cleanFilenamePart(value: string, fallback: string) {
  const cleaned = value.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return cleaned || fallback;
}

export function v2ExportFilename(session: V2Session, now = new Date()) {
  const records = assetsFor(session.launch);
  const world = session.launch.primaryAsset.type === 'world'
    ? session.launch.primaryAsset
    : records.find((asset) => asset.type === 'world');
  const location = records.find((asset) => asset.id === session.world.locationId && asset.type === 'place');
  const stamp = now.toISOString().replace(/:\d{2}\.\d{3}Z$/, '').replace('T', '_').replaceAll(':', '-');
  return [
    'Speculus',
    cleanFilenamePart(world?.name ?? session.launch.primaryAsset.name, 'Unbound'),
    cleanFilenamePart(location?.name ?? 'NoLocation', 'NoLocation'),
    cleanFilenamePart(session.launch.persona.name, 'Persona'),
    stamp,
  ].join('_') + '.json';
}

export function exportV2Session(session: V2Session, now = Date.now()): string {
  const state = stateSchema.parse(session);
  validateState(state, session.launch);
  const { id, revision, type, name } = session.launch.primaryAsset;
  const records = assetsFor(session.launch);
  const world = type === 'world' ? session.launch.primaryAsset : records.find((asset) => asset.type === 'world');
  const location = records.find((asset) => asset.id === session.world.locationId && asset.type === 'place');
  // No launch ID, grant, expiry, cookies or provider credentials are exported.
  return JSON.stringify({
    format: V2_EXPORT_FORMAT,
    source: {
      id, revision, type, name,
      world: world ? { id: world.id, revision: world.revision, name: world.name } : null,
      location: location ? { id: location.id, revision: location.revision, name: location.name } : null,
      persona: { id: session.launch.persona.id, name: session.launch.persona.name },
      character: session.launch.character ? { id: session.launch.character.id, name: session.launch.character.name } : null,
      exportedAt: now,
      elapsedSeconds: session.world.elapsedSeconds,
    },
    ...state,
  }, null, 2);
}

export function inspectV2Session(raw: string) {
  if (new Blob([raw]).size > MAX_V2_FILE_BYTES) throw new Error('The V2 file exceeds 16 MB.');
  const parsed = transferSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('This is not a supported V2 export. V1 files must stay in V1.');
  return parsed.data.source;
}

export function importV2Session(raw: string, current: V2Session): V2Session {
  if (new Blob([raw]).size > MAX_V2_FILE_BYTES) throw new Error('The V2 file exceeds 16 MB.');
  const parsed = transferSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('This is not a supported V2 export. V1 files must stay in V1.');
  const value = parsed.data;
  const source = current.launch.primaryAsset;
  if (value.source.id !== source.id || value.source.type !== source.type || value.source.revision !== source.revision) {
    throw new Error('Import requires the same Orbis record and canonical revision. No session was changed.');
  }
  validateState(value, current.launch);
  const { format: _format, source: _source, ...state } = value;
  return { ...current, ...state };
}

export function saveV2Session(session: V2Session, storage: Pick<Storage, 'setItem'> = sessionStorage): void {
  const state = stateSchema.parse(session);
  const launch = v2StoredPackageSchema.parse(session.launch);
  storage.setItem(V2_STORAGE_KEY, JSON.stringify({ ...state, id: session.id, launch }));
}

export function loadV2Session(storage: Pick<Storage, 'getItem'> = sessionStorage): V2Session | null {
  const raw = storage.getItem(V2_STORAGE_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as Record<string, unknown>;
  const launch = v2StoredPackageSchema.parse(value.launch);
  const state = stateSchema.parse(value);
  validateState(state, launch);
  return { ...state, launch, id: z.string().min(1).max(200).parse(value.id) };
}
