import { z } from 'zod';
import type { V4ClientPackage } from '../contracts/launch';
import type { ProviderAdapter } from '../../runtime/providers/types';
import { diagnosticsSchema, settingsSchema, type V4Session } from './session';
import { generateV4Turn, type V4GenerationOptions } from './engine';
import { captureSnapshot, reconstructAfterTurn, resolutionSchema, sameState, snapshotSchema } from './boundaries';
import { assertWorldCanon, perceptionFor } from './world';

const idSchema = z.string().min(1).max(300);
export const branchSourceSchema = z.object({
  sourceType: z.string().min(1), sourceId: z.string().min(1), sourceRevision: z.string().min(1),
  personaId: z.string().min(1), subjectId: z.string().nullable(),
});
export type V4BranchSource = z.infer<typeof branchSourceSchema>;
export function branchSourceFor(launch: V4ClientPackage): V4BranchSource {
  return { sourceType: launch.primaryAsset.type, sourceId: launch.primaryAsset.id, sourceRevision: launch.primaryAsset.revision,
    personaId: launch.persona.id, subjectId: launch.character?.id ?? null };
}
export const pageSourceSchema = z.object({
  kind: z.enum(['alternative', 'input-edit', 'reply-edit']), branchId: idSchema, turnId: idSchema, pageId: idSchema,
  forkTurnId: idSchema, forkPageId: idSchema,
});
export const pageHistoryDiagnosticsSchema = z.object({
  branchId: idSchema, pageId: idSchema, frontierTurnId: idSchema, frontierPageId: idSchema,
  sourceTurnId: idSchema.optional(), sourcePageId: idSchema.optional(),
});
export const branchPageSchema = z.object({
  id: idSchema, player: z.string().min(1).max(16000).optional(), source: pageSourceSchema.optional(),
  reply: z.string().min(1).max(64000), diagnostics: diagnosticsSchema.extend({ history: pageHistoryDiagnosticsSchema.optional() }),
  createdAt: z.number().finite(), worldRevision: z.number().int().nonnegative(), resolution: resolutionSchema.nullable(),
  before: snapshotSchema.nullable(), resolved: snapshotSchema.nullable(), after: snapshotSchema.nullable(),
});
export const branchTurnSchema = z.object({
  id: idSchema, player: z.string().min(1).max(16000), activePageId: idSchema, pages: z.array(branchPageSchema).min(1).max(1000),
});
const boundaryOwnerSchema = z.object({ turnId: idSchema, pageId: idSchema });
export const branchOperationSchema = z.object({
  id: idSchema, label: z.string().max(200), createdAt: z.number().finite(), turnId: idSchema.nullable(), pageId: idSchema.nullable(),
  source: boundaryOwnerSchema.optional(), before: snapshotSchema, after: snapshotSchema,
});
const branchShape = z.object({
  version: z.literal(4), engine: z.literal('v4'), storyId: idSchema, branchId: idSchema, parentBranchId: idSchema.nullable(),
  forkTurnId: idSchema.nullable(), forkPageId: idSchema.nullable(), lineage: z.array(idSchema).max(1000),
  label: z.string().min(1).max(200), createdAt: z.number().finite(), revision: z.number().int().nonnegative(), source: branchSourceSchema,
  settings: settingsSchema, draft: z.string().max(16000), turns: z.array(branchTurnSchema).max(20000),
  initial: snapshotSchema, head: snapshotSchema, operations: z.array(branchOperationSchema).max(40000), frontier: boundaryOwnerSchema.nullable(),
});
export type V4Branch = z.infer<typeof branchShape>;
const validatedBranchSchema = branchShape.superRefine((branch, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const used = new Set<string>([branch.branchId]);
  const unique = (id: string) => { if (used.has(id)) fail('Branch identities must be unique.'); used.add(id); };
  const emptyFork = branch.turns.length === 0 && branch.forkTurnId === null && branch.forkPageId === null;
  if (new Set(branch.lineage).size !== branch.lineage.length || branch.lineage.includes(branch.branchId)
    || (branch.parentBranchId === null ? branch.lineage.length || branch.forkTurnId || branch.forkPageId
      : branch.lineage.at(-1) !== branch.parentBranchId || (!emptyFork && (!branch.forkTurnId || !branch.forkPageId)))) fail('Branch lineage is inconsistent.');
  const last = branch.turns.at(-1);
  if (!sameState(branch.frontier, last ? { turnId: last.id, pageId: last.activePageId } : null)) fail('Branch frontier is inconsistent.');
  if (branch.parentBranchId && !emptyFork && !branch.turns.some((turn) => turn.id === branch.forkTurnId
    && turn.pages.some((page) => page.id === branch.forkPageId))) fail('Fork boundary is not a branch member.');
  let state = branch.initial;
  let operationIndex = 0;
  const applyOperations = (turnId: string | null, pageId: string | null) => {
    while (branch.operations[operationIndex]?.turnId === turnId) {
      const op = branch.operations[operationIndex++]; unique(op.id);
      if (op.pageId !== pageId || !sameState(op.before, state)) fail('Operation boundary linkage is inconsistent.');
      if (op.after.nextTurn !== op.before.nextTurn || op.after.world.revision < op.before.world.revision
        || !sameState(op.after.events.slice(0, op.before.events.length), op.before.events)) fail('Operation cannot rewrite its prior boundary.');
      if (op.source && !branch.turns.slice(0, branch.turns.findIndex((turn) => turn.id === turnId) + 1)
        .some((turn) => turn.id === op.source!.turnId && turn.pages.some((page) => page.id === op.source!.pageId))) fail('Operation source is not a prior branch member.');
      state = op.after;
    }
  };
  applyOperations(null, null);
  let completeSeen = false;
  for (const turn of branch.turns) {
    unique(turn.id);
    if (!turn.pages.some((page) => page.id === turn.activePageId)) fail('Active page is not a turn member.');
    if (turn.pages.find((page) => page.id === turn.activePageId)?.player !== undefined
      && turn.pages.find((page) => page.id === turn.activePageId)?.player !== turn.player) fail('Selected page input does not match its turn.');
    for (const page of turn.pages) {
      unique(page.id);
      if (page.diagnostics.worldRevision !== page.worldRevision) fail('Page diagnostics world revision is inconsistent.');
      if (page.source && (page.source.turnId !== turn.id || page.source.pageId === page.id
        || !turn.pages.some((value) => value.id === page.source!.pageId)
        || page.source.forkTurnId !== turn.id || page.source.forkPageId !== page.source.pageId
        || ![branch.branchId, ...branch.lineage].includes(page.source.branchId))) fail('Page source linkage is inconsistent.');
      if (page.source) {
        const source = turn.pages.find((value) => value.id === page.source!.pageId);
        if (!source || turn.pages.indexOf(source) >= turn.pages.indexOf(page) || !sameState(page.before, source.before)
          || (page.source.kind !== 'input-edit' && (page.player !== (source.player ?? turn.player)
            || !sameState(page.resolved, source.resolved) || !sameState(page.resolution, source.resolution)))) fail('Page source resolution/input linkage is inconsistent.');
      }
      const history = page.diagnostics.history;
      if (history && (history.pageId !== page.id || history.frontierTurnId !== turn.id || history.frontierPageId !== page.id
        || ![branch.branchId, ...branch.lineage].includes(history.branchId)
        || (history.sourceTurnId !== undefined && history.sourceTurnId !== turn.id)
        || (history.sourcePageId !== undefined && !turn.pages.some((value) => value.id === history.sourcePageId)))) fail('Page history diagnostics linkage is inconsistent.');
      const complete = [page.before, page.resolved, page.after, page.resolution].filter(Boolean).length;
      if (complete !== 0 && complete !== 4) fail('Page checkpoints must be complete or null.');
      if (page.before && page.resolved && page.after && page.resolution) {
        if (page.resolution.worldRevisionBefore !== page.before.world.revision
          || page.resolution.worldRevisionAfter !== page.resolved.world.revision
          || page.resolution.elapsedSeconds !== page.resolved.world.elapsedSeconds - page.before.world.elapsedSeconds
          || page.resolution.playerActorId !== branch.source.personaId || page.resolution.subjectActorId !== branch.source.subjectId
          || !sameState(page.resolution.playerPerception, perceptionFor(page.resolved.world, page.resolution.playerActorId))
          || !sameState(page.resolution.subjectPerception, page.resolution.subjectActorId ? perceptionFor(page.resolved.world, page.resolution.subjectActorId) : null)
          || page.worldRevision !== page.after.world.revision || !sameState(page.resolved.world, page.after.world)
          || page.resolved.nextTurn !== page.before.nextTurn || page.after.nextTurn !== page.before.nextTurn + 1
          || !sameState(page.before.relationships, page.resolved.relationships)
          || !sameState(page.before.stateProposals, page.resolved.stateProposals)
          || !sameState(page.before.events, page.resolved.events)
          || !sameState(page.after.events.slice(0, page.before.events.length), page.before.events)) fail('Page resolution/checkpoint linkage is inconsistent.');
        if (!page.after.events.some((event) => event.kind === 'turn' && event.id === turn.id)) fail('Page commit event is missing.');
      }
    }
    const selected = turn.pages.find((page) => page.id === turn.activePageId);
    if (selected?.before && selected.after) {
      completeSeen = true;
      if (!sameState(state, selected.before)) fail('Turn boundary linkage is inconsistent.');
      state = selected.after;
    } else if (completeSeen) fail('Unverifiable history cannot follow complete turns.');
    applyOperations(turn.id, turn.activePageId);
  }
  if (operationIndex !== branch.operations.length) fail('Operation chronology is inconsistent.');
  if (!sameState(state, branch.head)) fail('Branch head is inconsistent with its frontier.');
  const validateLedger = (snapshot: z.infer<typeof snapshotSchema>, frontierIndex: number, frontierPageId?: string) => {
    const prefix = branch.turns.slice(0, frontierIndex + 1).map((turn) => turn.id);
    const future = new Set(branch.turns.slice(frontierIndex + 1).map((turn) => turn.id));
    const ids = snapshot.events.map((event) => event.id);
    if (new Set(ids).size !== ids.length || snapshot.events.some((event) => event.worldRevision > snapshot.world.revision
      || (event.world && event.world.revision !== event.worldRevision)
      || (event.kind === 'turn' && !branch.turns.some((turn) => turn.id === event.id))
      || (event.ownerTurnId && !branch.turns.some((turn) => turn.id === event.ownerTurnId)))) fail('Snapshot event ledger is inconsistent.');
    if (snapshot.events.some((event, index) => index > 0 && event.worldRevision < snapshot.events[index - 1].worldRevision)) fail('Snapshot event chronology is inconsistent.');
    if (!sameState(snapshot.events.filter((event) => event.kind === 'turn').map((event) => event.id), prefix)
      || snapshot.events.some((event) => event.ownerTurnId && future.has(event.ownerTurnId))) fail('Snapshot contains an inconsistent turn prefix.');
    if (new Set(snapshot.stateProposals.map((proposal) => proposal.id)).size !== snapshot.stateProposals.length
      || snapshot.stateProposals.some((proposal) => !prefix.includes(proposal.sourceTurnId))) fail('Snapshot proposal ownership is inconsistent.');
    if (snapshot.stateProposals.some((proposal) => proposal.sourcePageId !== undefined
      && (!proposal.id.startsWith(`proposal:${proposal.sourcePageId}:`) || proposal.sourcePageId !== (proposal.sourceTurnId === prefix.at(-1)
        ? frontierPageId ?? branch.turns[frontierIndex]?.activePageId : branch.turns.find((turn) => turn.id === proposal.sourceTurnId)?.activePageId)))) fail('Snapshot proposal page ownership is inconsistent.');
    if (Object.values(snapshot.relationships).some((relationship) => relationship.events.some((event) => future.has(event.turnId)))
      || [snapshot.world, ...snapshot.events.flatMap((event) => event.world ? [event.world] : [])].some(({ domains }) =>
        domains.conditions.some((condition) => condition.ownerTurnId && future.has(condition.ownerTurnId))
        || domains.chronicle.some((entry) => entry.sourceTurnIds.some((id) => future.has(id)))
        || domains.relationships.some((relationship) => relationship.events.some((event) => event.ownerTurnId && future.has(event.ownerTurnId))))) fail('Snapshot contains descendant state.');
  };
  const importedCount = branch.turns.findIndex((turn) => turn.pages.find((page) => page.id === turn.activePageId)?.before !== null);
  validateLedger(branch.initial, importedCount < 0 ? branch.turns.length - 1 : importedCount - 1);
  validateLedger(branch.head, branch.turns.length - 1);
  for (const op of branch.operations) {
    const index = op.turnId === null ? -1 : branch.turns.findIndex((turn) => turn.id === op.turnId);
    validateLedger(op.before, index); validateLedger(op.after, index);
  }
  branch.turns.forEach((turn, index) => { for (const page of turn.pages) {
    if (page.before) validateLedger(page.before, index - 1);
    if (page.resolved) validateLedger(page.resolved, index - 1);
    if (page.after) validateLedger(page.after, index, page.id);
  } });
});

// Branch saves are complete authority, not a migration reader: never fill in
// missing checkpoint fields with the inherited flat-session schema defaults.
export const branchSchema = z.unknown().transform((value, ctx): V4Branch => {
  const parsed = validatedBranchSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    return z.NEVER;
  }
  const complete = (raw: unknown, normalized: unknown): boolean => {
    if (Object.is(raw, normalized)) return true;
    if (!raw || !normalized || typeof raw !== 'object' || typeof normalized !== 'object') return false;
    if (Array.isArray(normalized)) return Array.isArray(raw) && raw.length === normalized.length
      && normalized.every((item, index) => complete(raw[index], item));
    const record = raw as Record<string, unknown>;
    return Object.entries(normalized).every(([key, item]) => item === undefined || (Object.hasOwn(record, key) && complete(record[key], item)));
  };
  if (!complete(value, parsed.data)) {
    ctx.addIssue({ code: 'custom', message: 'Branch authority contains missing checkpoint fields.' });
    return z.NEVER;
  }
  return parsed.data;
});

export function createRootBranch(session: V4Session): V4Branch {
  const turns = session.turns.map(({ id, player, ...flat }) => {
    const pageId = crypto.randomUUID();
    return { id, player, activePageId: pageId, pages: [{ ...flat, diagnostics: diagnosticsSchema.parse(flat.diagnostics),
      id: pageId, player, resolution: null, before: null, resolved: null, after: null }] };
  });
  return branchSchema.parse({ version: 4, engine: 'v4', storyId: session.id, branchId: crypto.randomUUID(), parentBranchId: null,
    forkTurnId: null, forkPageId: null, lineage: [], label: 'Root', createdAt: Date.now(), revision: 0, source: branchSourceFor(session.launch),
    settings: session.settings, draft: session.draft, turns, initial: captureSnapshot(session), head: captureSnapshot(session), operations: [],
    frontier: turns.length ? { turnId: turns.at(-1)!.id, pageId: turns.at(-1)!.activePageId } : null });
}

export function projectBranch(branch: V4Branch, launch: V4ClientPackage): V4Session {
  const valid = branchSchema.parse(branch);
  if (!sameState(valid.source, branchSourceFor(launch))) throw new Error('Branch source does not match the launch authorization.');
  const validateWorld = (world: V4Session['world']) => {
    assertWorldCanon(world, launch);
    const actors = new Set(world.actors.map((actor) => actor.id));
    const domains = world.domains;
    if (domains.conditions.some((condition) => !actors.has(condition.actorId))
      || domains.resources.some((resource) => resource.ownerActorId !== null && !actors.has(resource.ownerActorId))
      || domains.relationships.some((relationship) => relationship.actorIds.some((id) => !actors.has(id)))
      || domains.mysteries.some((mystery) => mystery.knownByActorIds.some((id) => !actors.has(id)))) {
      throw new Error('World domains reference an unpackaged actor.');
    }
  };
  for (const snapshot of [valid.initial, valid.head, ...valid.operations.flatMap((op) => [op.before, op.after]),
    ...valid.turns.flatMap((turn) => turn.pages.flatMap((page) => [page.before, page.resolved, page.after]))]) {
    if (snapshot) { validateWorld(snapshot.world); for (const event of snapshot.events) if (event.world) validateWorld(event.world); }
  }
  return structuredClone({ version: 4, engine: 'v4', id: valid.storyId, launch, ...valid.head, settings: valid.settings, draft: valid.draft,
    turns: valid.turns.map((turn) => {
      const page = turn.pages.find((value) => value.id === turn.activePageId)!;
      return { id: turn.id, player: turn.player, reply: page.reply, diagnostics: page.diagnostics, createdAt: page.createdAt, worldRevision: page.worldRevision };
    }) });
}

export function captureBranchOperation(branch: V4Branch, nextFlatSession: V4Session, label: string, source?: z.infer<typeof boundaryOwnerSchema>): V4Branch {
  const previous = projectBranch(branch, nextFlatSession.launch);
  if (nextFlatSession.id !== branch.storyId || !sameState(previous.turns, nextFlatSession.turns)) throw new Error('Operations cannot change branch history.');
  const after = captureSnapshot(nextFlatSession);
  const changed = !sameState(branch.head, after);
  const candidate = branchSchema.parse({ ...branch, head: after, settings: nextFlatSession.settings, draft: nextFlatSession.draft,
    revision: branch.revision + 1, operations: changed ? [...branch.operations, {
      id: crypto.randomUUID(), label, createdAt: Date.now(), turnId: branch.frontier?.turnId ?? null, pageId: branch.frontier?.pageId ?? null,
      ...(source ? { source } : {}), before: branch.head, after,
    }] : branch.operations });
  projectBranch(candidate, nextFlatSession.launch);
  return candidate;
}

export function forkBranch(branch: V4Branch, turnId: string, pageId?: string): V4Branch {
  const valid = branchSchema.parse(branch);
  const head = reconstructAfterTurn(valid, turnId, pageId);
  const index = valid.turns.findIndex((turn) => turn.id === turnId);
  const turns = valid.turns.slice(0, index + 1);
  const selected = turns.at(-1)!.pages.find((page) => page.id === (pageId ?? turns.at(-1)!.activePageId))!;
  const replaced = selected.id !== turns.at(-1)!.activePageId;
  turns.at(-1)!.activePageId = selected.id;
  turns.at(-1)!.player = selected.player ?? turns.at(-1)!.player;
  const ids = new Set(turns.map((turn) => turn.id));
  return branchSchema.parse({ ...structuredClone(valid), branchId: crypto.randomUUID(), parentBranchId: valid.branchId,
    forkTurnId: turnId, forkPageId: pageId ?? turns.at(-1)!.activePageId, lineage: [...valid.lineage, valid.branchId],
    label: `Fork after ${index + 1}`, createdAt: Date.now(), revision: 0, turns, head,
    operations: valid.operations.filter((op) => (op.turnId === null || ids.has(op.turnId)) && (!replaced || op.turnId !== turnId)),
    frontier: { turnId, pageId: pageId ?? turns.at(-1)!.activePageId } });
}

export async function generationBranchTurn(branch: V4Branch, launch: V4ClientPackage, provider: ProviderAdapter,
  options: Omit<V4GenerationOptions, 'reroll' | 'turnId' | 'pageId' | 'editedReply' | 'recordedResolution' | 'onCheckpoints'> = {}): Promise<V4Branch> {
  const session = projectBranch(branch, launch);
  let checkpoints: Parameters<NonNullable<V4GenerationOptions['onCheckpoints']>>[0] | undefined;
  const pageId = crypto.randomUUID();
  const next = await generateV4Turn(session, provider, { ...options, pageId, turnId: `v4:${crypto.randomUUID()}`, onCheckpoints: (value) => { checkpoints = value; } });
  if (!checkpoints) throw new Error('Generation did not capture complete boundaries.');
  const flat = next.turns.at(-1)!;
  const turn = { id: flat.id, player: flat.player, activePageId: pageId, pages: [{
    id: pageId, player: flat.player, reply: flat.reply,
    diagnostics: { ...flat.diagnostics, history: { branchId: branch.branchId, pageId, frontierTurnId: flat.id, frontierPageId: pageId } },
    createdAt: flat.createdAt, worldRevision: flat.worldRevision,
    resolution: checkpoints.resolution, before: captureSnapshot(checkpoints.before), resolved: captureSnapshot(checkpoints.resolved), after: captureSnapshot(checkpoints.after),
  }] };
  const candidate = branchSchema.parse({ ...branch, turns: [...branch.turns, turn], head: captureSnapshot(next), draft: next.draft,
    revision: branch.revision + 1, frontier: { turnId: turn.id, pageId } });
  projectBranch(candidate, launch);
  return candidate;
}

export { generateAlternative, selectPage, editTurn, deleteLatestAsBranch } from './history';
export type { V4HistoryOptions, V4EditOptions } from './history';
