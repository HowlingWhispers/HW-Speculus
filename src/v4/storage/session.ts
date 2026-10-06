import { z } from 'zod';
import { v4StoredPackageSchema, type V4ClientPackage } from '../contracts/launch';
import { eventSchema, relationshipStateSchema, sessionStateProposalsSchema, settingsSchema, turnSchema, type V4Session } from '../runtime/session';
import { assertWorldCanon, assetsFor, createWorld, worldSchema } from '../runtime/world';
import { SKIPPED_PERSONA_TURN, skippedPersonaTurnAs } from '../runtime/turn-control';

export const V4_STORAGE_KEY = 'speculus.session.v4';
export const V4_EXPORT_FORMAT = 'speculus-v4-session';
export const MAX_V4_FILE_BYTES = 16 * 1024 * 1024;
const stateSchema = z.object({
  version: z.literal(4), engine: z.literal('v4'), world: worldSchema,
  settings: settingsSchema, draft: z.string().max(16000), turns: z.array(turnSchema).max(20000),
  events: z.array(eventSchema).max(40000), nextTurn: z.number().int().positive(),
  relationships: relationshipStateSchema,
  stateProposals: sessionStateProposalsSchema,
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
  simulationDay: z.number().int().positive().optional(),
});
const transferSchema = stateSchema.extend({ format: z.literal(V4_EXPORT_FORMAT), source: sourceSchema });

/** Top-level shape of any Speculus save, used to classify a file before validation. */
const COMPATIBLE_EXPORT_FORMAT = 'speculus-v2-session';
const V1_EXPORT_FORMATS = new Set(['speculus-session', 'speculus-raw-session', 'speculus-session-v1', 'speculus-v1-session']);

export class SpeculusImportError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'SpeculusImportError';
  }
}

type ImportClassification =
  | { kind: 'v4' }
  | { kind: 'v2-compatible' }
  | { kind: 'v1' }
  | { kind: 'unknown' };

/**
 * Separates JSON syntax problems and file identity from current-schema
 * validation, so a valid Speculus save is never reported as a V1 file.
 */
function classifyTransfer(value: unknown): ImportClassification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown' };
  const record = value as Record<string, unknown>;
  const format = typeof record.format === 'string' ? record.format : null;
  if (format === V4_EXPORT_FORMAT && record.version === 4) return { kind: 'v4' };
  if (format === COMPATIBLE_EXPORT_FORMAT && record.version === 2 && record.engine === 'v2') return { kind: 'v2-compatible' };
  if (format && V1_EXPORT_FORMATS.has(format)) return { kind: 'v1' };
  if (format) return { kind: 'unknown' };
  // Bare compatible state is recognized, but the transfer schema still requires a format/source.
  if (record.version === 2 && record.engine === 'v2' && Array.isArray(record.turns)) return { kind: 'v2-compatible' };
  return { kind: 'unknown' };
}

function parseTransferJson(raw: string): Record<string, unknown> {
  if (new Blob([raw]).size > MAX_V4_FILE_BYTES) throw new SpeculusImportError('The V4 experimental file exceeds 16 MB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SpeculusImportError('Import failed: this file is not valid JSON.', cause instanceof Error ? cause.message : undefined);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpeculusImportError('This file is not a recognized Speculus session export.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Safe, semantics-preserving migration for exports written before optional
 * fields existed. Only defaults for genuinely optional/derived collections are
 * applied; canonical world state and turns are never fabricated or altered.
 */
function migrateV4Transfer(value: Record<string, unknown>) {
  const migrated: Record<string, unknown> = { ...value };
  if (migrated.stateProposals === undefined) migrated.stateProposals = [];
  if (migrated.relationships === undefined) migrated.relationships = {};
  if (migrated.draft === undefined || migrated.draft === null) migrated.draft = '';
  if (migrated.settings === undefined || migrated.settings === null) migrated.settings = {};
  if (migrated.settings && typeof migrated.settings === 'object' && !Array.isArray(migrated.settings)) {
    const settings = { ...(migrated.settings as Record<string, unknown>) };
    // settingsSchema already defaults these; being explicit documents intent.
    for (const key of ['tone', 'tags', 'freeform', 'stopSequences'] as const) {
      if (settings[key] === undefined) settings[key] = Array.isArray(settings[key]) ? [] : '';
    }
    migrated.settings = settings;
  }
  if (Array.isArray(migrated.turns)) {
    migrated.turns = migrated.turns.map((turn) => {
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return turn;
      const record = turn as Record<string, unknown>;
      const diagnostics = record.diagnostics;
      if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) return turn;
      const fixed = { ...(diagnostics as Record<string, unknown>) };
      // These are presentation/diagnostic collections. Older exports predate
      // several of them; an empty list preserves their original meaning.
      for (const key of ['included', 'omitted', 'issues', 'warnings'] as const) {
        if (fixed[key] === undefined || fixed[key] === null) fixed[key] = [];
      }
      if (typeof fixed.prompt !== 'string') fixed.prompt = fixed.prompt === undefined ? '' : String(fixed.prompt);
      for (const key of ['estimatedInputTokens', 'outputBudget', 'durationMs'] as const) {
        if (typeof fixed[key] !== 'number' || !Number.isFinite(fixed[key])) fixed[key] = 0;
      }
      if (typeof fixed.model !== 'string') fixed.model = 'unknown';
      if (typeof fixed.completionStatus !== 'string') fixed.completionStatus = 'unknown';
      if (typeof fixed.worldRevision !== 'number' || !Number.isFinite(fixed.worldRevision)) fixed.worldRevision = 0;
      return { ...record, diagnostics: fixed };
    });
  }
  return migrated;
}

function migrateCompatibleTransfer(value: Record<string, unknown>) {
  const migrated = migrateV4Transfer(value);
  migrated.format = V4_EXPORT_FORMAT;
  migrated.version = 4;
  migrated.engine = 'v4';
  if (Array.isArray(migrated.turns)) {
    migrated.turns = migrated.turns.map((turn) => {
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return turn;
      const record = turn as Record<string, unknown>;
      const player = record.player;
      if (player === '__speculus_v3_persona_turn_skipped__' || player === '__speculus_v2_persona_turn_skipped__') {
        return { ...record, player: SKIPPED_PERSONA_TURN };
      }
      const prefix = '__speculus_v3_persona_turn_skipped_as__:';
      if (typeof player === 'string' && player.startsWith(prefix)) {
        return { ...record, player: skippedPersonaTurnAs(player.slice(prefix.length)) };
      }
      return record;
    });
  }
  return migrated;
}

function firstIssueReason(issues: z.core.$ZodIssue[]) {
  const issue = issues[0];
  if (!issue) return 'the file did not match the current save schema.';
  const path = issue.path.length ? issue.path.join('.') : 'root';
  return `${path}: ${issue.message}`;
}

function parseV4Transfer(raw: string) {
  const parsedJson = parseTransferJson(raw);
  const classification = classifyTransfer(parsedJson);
  if (classification.kind === 'v1') {
    throw new SpeculusImportError('This is a V1 save. V1 files must stay in V1.', `format: ${String(parsedJson.format)}`);
  }
  if (classification.kind === 'unknown') {
    throw new SpeculusImportError('This file is not a recognized Speculus session export.');
  }
  const migrated = classification.kind === 'v2-compatible' ? migrateCompatibleTransfer(parsedJson) : parsedJson;
  const parsed = transferSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new SpeculusImportError(
      'Speculus recognized this session export, but it could not be migrated to the V4 save schema.',
      firstIssueReason(parsed.error.issues),
    );
  }
  return parsed.data;
}

function reconcileWorldActors(world: z.infer<typeof worldSchema>, launch: V4ClientPackage) {
  const expected = createWorld(launch).actors;
  const savedById = new Map(world.actors.map((actor) => [actor.id, actor]));
  const packagedPlaces = new Set(assetsFor(launch).filter((asset) => asset.type === 'place').map((asset) => asset.id));
  const validLocation = (locationId: string | null) => locationId && packagedPlaces.has(locationId) ? locationId : null;
  return {
    ...world,
    locationId: validLocation(world.locationId),
    actors: expected.map((actor) => {
      const saved = savedById.get(actor.id);
      return saved
        ? { ...actor, locationId: validLocation(saved.locationId), knowledge: saved.knowledge }
        : actor;
    }),
  };
}

function reconcileImportedStateActors(state: z.infer<typeof stateSchema>, launch: V4ClientPackage) {
  return {
    ...state,
    world: reconcileWorldActors(state.world, launch),
    events: state.events.map((event) => event.kind === 'operator' && event.world
      ? { ...event, world: reconcileWorldActors(event.world, launch) }
      : event),
  };
}

function validateState(state: z.infer<typeof stateSchema>, launch: V4ClientPackage) {
  assertWorldCanon(state.world, launch);
  const ids = new Set(state.turns.map((turn) => turn.id));
  const turnsById = new Map(state.turns.map((turn) => [turn.id, turn]));
  if (ids.size !== state.turns.length || state.nextTurn <= state.turns.length) throw new Error('Invalid V4 turn identity or counter.');
  if (new Set(state.events.map((event) => event.id)).size !== state.events.length) throw new Error('V4 ledger has duplicate event identities.');
  for (const turn of state.turns) {
    const ordinal = Number(turn.id.match(/:([1-9][0-9]*)$/)?.[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal >= state.nextTurn) throw new Error('V4 turn counter would reuse an existing identity.');
  }
  const turnEvents = state.events.filter((event) => event.kind === 'turn');
  if (turnEvents.length !== ids.size || new Set(turnEvents.map((event) => event.id)).size !== ids.size
    || turnEvents.some((event) => !ids.has(event.id))) throw new Error('V4 event ledger does not match its turns.');
  let replay = createWorld(launch);
  for (const event of state.events) {
    if (event.kind === 'operator') {
      if (!event.world || event.worldRevision !== replay.revision + 1 || event.world.revision !== event.worldRevision
        || event.world.elapsedSeconds < replay.elapsedSeconds) throw new Error('V4 operator ledger has inconsistent world revisions.');
      assertWorldCanon(event.world, launch); replay = event.world;
    } else {
      const turn = turnsById.get(event.id)!;
      if (event.worldRevision !== replay.revision || turn.worldRevision !== replay.revision || turn.diagnostics.worldRevision !== replay.revision) {
        throw new Error('V4 turn references an inconsistent world revision.');
      }
    }
  }
  if (JSON.stringify(replay) !== JSON.stringify(state.world)) throw new Error('V4 world state does not match its operator ledger.');
}

function cleanFilenamePart(value: string, fallback: string) {
  const cleaned = value.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return cleaned || fallback;
}

export function v4ExportFilename(session: V4Session, now = new Date()) {
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

export function exportV4Session(session: V4Session, now = Date.now()): string {
  const state = stateSchema.parse(session);
  validateState(state, session.launch);
  const { id, revision, type, name } = session.launch.primaryAsset;
  const records = assetsFor(session.launch);
  const world = type === 'world' ? session.launch.primaryAsset : records.find((asset) => asset.type === 'world');
  const location = records.find((asset) => asset.id === session.world.locationId && asset.type === 'place');
  // No launch ID, grant, expiry, cookies or provider credentials are exported.
  return JSON.stringify({
    format: V4_EXPORT_FORMAT,
    source: {
      id, revision, type, name,
      world: world ? { id: world.id, revision: world.revision, name: world.name } : null,
      location: location ? { id: location.id, revision: location.revision, name: location.name } : null,
      persona: { id: session.launch.persona.id, name: session.launch.persona.name },
      character: session.launch.character ? { id: session.launch.character.id, name: session.launch.character.name } : null,
      exportedAt: now,
      elapsedSeconds: session.world.elapsedSeconds,
      simulationDay: session.world.simulationDay,
    },
    ...state,
  }, null, 2);
}

export function inspectV4Session(raw: string) {
  return parseV4Transfer(raw).source;
}

export function importV4Session(raw: string, current: V4Session): V4Session {
  const value = parseV4Transfer(raw);
  const source = current.launch.primaryAsset;
  if (value.source.id !== source.id || value.source.type !== source.type || value.source.revision !== source.revision) {
    throw new SpeculusImportError('Import requires the same Orbis record and canonical revision. No session was changed.');
  }
  const { format: _format, source: _source, ...rawState } = value;
  const state = reconcileImportedStateActors(rawState, current.launch);
  validateState(state, current.launch);
  return { ...current, ...state };
}

export function saveV4Session(session: V4Session, storage: Pick<Storage, 'setItem'> = sessionStorage): void {
  const state = stateSchema.parse(session);
  const launch = v4StoredPackageSchema.parse(session.launch);
  storage.setItem(V4_STORAGE_KEY, JSON.stringify({ ...state, id: session.id, launch }));
}

export function loadV4Session(storage: Pick<Storage, 'getItem'> = sessionStorage): V4Session | null {
  const raw = storage.getItem(V4_STORAGE_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as Record<string, unknown>;
  const launch = v4StoredPackageSchema.parse(value.launch);
  const state = stateSchema.parse(value);
  validateState(state, launch);
  return { ...state, launch, id: z.string().min(1).max(200).parse(value.id) };
}
