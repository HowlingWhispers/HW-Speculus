import type { V4ClientPackage } from '../contracts/launch';
import type { ProviderAdapter } from '../../runtime/providers/types';
import { branchSchema, forkBranch, projectBranch, type V4Branch } from './branches';
import { captureSnapshot, sameState } from './boundaries';
import { generateV4Turn, type EnginePhase, type V4GenerationOptions } from './engine';
import { isSkippedPersonaTurn, skippedPersonaActorId } from './turn-control';

export type V4HistoryOptions = { signal?: AbortSignal; onPhase?: (phase: EnginePhase) => void; now?: number };
export type V4EditOptions = V4HistoryOptions & { player?: string; reply?: string };

async function regeneratePage(branch: V4Branch, launch: V4ClientPackage, provider: ProviderAdapter, turnId: string,
  options: V4EditOptions, kind: 'alternative' | 'input-edit' | 'reply-edit', outcomeBranchId: string) {
  const projected = projectBranch(branch, launch);
  const index = branch.turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) throw new Error('History turn is not in this branch.');
  const turn = branch.turns[index];
  const original = turn.pages.find((page) => page.id === turn.activePageId)!;
  if (!original.before || !original.resolved || !original.after || !original.resolution) throw new Error('Historical boundary is unverifiable.');
  const player = options.player?.trim() ?? turn.player;
  // Both state and every memory tier come from this exact prefix. No rollback,
  // descendant replay, or flattening of inactive pages participates here.
  const base = { ...projected, ...structuredClone(original.before), draft: player, turns: projected.turns.slice(0, index) };
  const pageId = crypto.randomUUID();
  let checkpoints: Parameters<NonNullable<V4GenerationOptions['onCheckpoints']>>[0] | undefined;
  const next = await generateV4Turn(base, provider, {
    ...options, turnId, pageId, skipPersona: isSkippedPersonaTurn(player), skipAsActorId: skippedPersonaActorId(player) ?? undefined,
    ...(kind === 'input-edit' ? {} : { recordedResolution: { resolution: original.resolution, resolvedSession: { ...base, ...structuredClone(original.resolved) } } }),
    ...(kind === 'reply-edit' ? { editedReply: options.reply } : {}),
    onCheckpoints: (value) => { checkpoints = value; },
  });
  if (!checkpoints) throw new Error('History generation did not capture complete boundaries.');
  const flat = next.turns.at(-1)!;
  return {
    id: pageId, player: flat.player, reply: flat.reply, createdAt: flat.createdAt, worldRevision: flat.worldRevision,
    source: { kind, branchId: branch.branchId, turnId, pageId: original.id, forkTurnId: turnId, forkPageId: original.id },
    diagnostics: { ...flat.diagnostics, history: { branchId: outcomeBranchId, pageId, frontierTurnId: turnId, frontierPageId: pageId, sourceTurnId: turnId, sourcePageId: original.id } },
    resolution: checkpoints.resolution, before: captureSnapshot(checkpoints.before), resolved: captureSnapshot(checkpoints.resolved), after: captureSnapshot(checkpoints.after),
  };
}

export async function generateAlternative(branch: V4Branch, launch: V4ClientPackage, provider: ProviderAdapter, turnId: string,
  options: V4HistoryOptions = {}): Promise<V4Branch> {
  const valid = branchSchema.parse(branch);
  const page = await regeneratePage(valid, launch, provider, turnId, options, 'alternative', valid.branchId);
  const candidate = branchSchema.parse({ ...valid, revision: valid.revision + 1,
    turns: valid.turns.map((turn) => turn.id === turnId ? { ...turn, pages: [...turn.pages, page] } : turn) });
  projectBranch(candidate, launch);
  return candidate;
}

export function selectPage(branch: V4Branch, turnId: string, pageId: string): V4Branch {
  const valid = branchSchema.parse(branch);
  const turn = valid.turns.find((value) => value.id === turnId);
  const page = turn?.pages.find((value) => value.id === pageId);
  if (!turn || !page) throw new Error('Selected page is not in this branch.');
  if (!page.before || !page.resolved || !page.after || !page.resolution) throw new Error('Historical boundary is unverifiable.');
  if (valid.turns.at(-1)!.id !== turnId || valid.operations.some((operation) => operation.turnId === turnId)) {
    return forkBranch(valid, turnId, pageId);
  }
  if (pageId === turn.activePageId) return valid;
  const current = turn.pages.find((value) => value.id === turn.activePageId)!;
  if (!sameState(current.before, page.before)) throw new Error('Selected page does not match the current turn boundary.');
  return branchSchema.parse({ ...valid, revision: valid.revision + 1, head: page.after, frontier: { turnId, pageId },
    turns: valid.turns.map((value) => value.id === turnId ? { ...value, player: page.player ?? value.player, activePageId: pageId } : value) });
}

export async function editTurn(branch: V4Branch, launch: V4ClientPackage, provider: ProviderAdapter, turnId: string,
  options: V4EditOptions): Promise<V4Branch> {
  const valid = branchSchema.parse(branch);
  const index = valid.turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) throw new Error('History turn is not in this branch.');
  const turn = valid.turns[index];
  const original = turn.pages.find((page) => page.id === turn.activePageId)!;
  const inputChanged = options.player !== undefined && options.player.trim() !== turn.player;
  if (!inputChanged && options.reply === undefined) throw new Error('An edit must change player input or supply a reply.');
  if (inputChanged && options.reply !== undefined && options.reply !== original.reply) throw new Error('Edit player input and regenerate, or edit the reply separately.');
  const child = index !== valid.turns.length - 1 || valid.operations.some((operation) => operation.turnId === turnId);
  const branchId = child ? crypto.randomUUID() : valid.branchId;
  const page = await regeneratePage(valid, launch, provider, turnId, options, inputChanged ? 'input-edit' : 'reply-edit', branchId);
  const turns = valid.turns.slice(0, index + 1);
  turns[index] = { ...turn, player: page.player, activePageId: page.id,
    pages: [...turn.pages.map((previous) => ({ ...previous, player: previous.player ?? turn.player })), page] };
  const prefixIds = new Set(turns.slice(0, -1).map((value) => value.id));
  const candidate = branchSchema.parse({ ...valid, branchId,
    ...(child ? { parentBranchId: valid.branchId, lineage: [...valid.lineage, valid.branchId], forkTurnId: turnId, forkPageId: page.id,
      label: `Edit turn ${index + 1}`, createdAt: options.now ?? Date.now() } : {}),
    revision: child ? 0 : valid.revision + 1, turns, head: page.after,
    operations: valid.operations.filter((operation) => operation.turnId === null || prefixIds.has(operation.turnId)),
    frontier: { turnId, pageId: page.id } });
  projectBranch(candidate, launch);
  return candidate;
}

export function deleteLatestAsBranch(branch: V4Branch): V4Branch {
  const valid = branchSchema.parse(branch);
  const latest = valid.turns.at(-1);
  const page = latest?.pages.find((value) => value.id === latest.activePageId);
  if (!latest || !page?.before || !page.resolved || !page.after || !page.resolution) throw new Error('Latest before boundary is unverifiable.');
  const turns = valid.turns.slice(0, -1);
  const prior = turns.at(-1);
  const prefixIds = new Set(turns.map((turn) => turn.id));
  return branchSchema.parse({ ...valid, branchId: crypto.randomUUID(), parentBranchId: valid.branchId,
    lineage: [...valid.lineage, valid.branchId], forkTurnId: prior?.id ?? null, forkPageId: prior?.activePageId ?? null,
    label: 'Before latest turn', createdAt: Date.now(), revision: 0, turns, head: page.before, draft: latest.player,
    operations: valid.operations.filter((operation) => operation.turnId === null || prefixIds.has(operation.turnId)),
    frontier: prior ? { turnId: prior.id, pageId: prior.activePageId } : null });
}
