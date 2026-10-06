import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicV4Package } from '../src/v4/contracts/launch';
import { branchSchema, captureBranchOperation, createRootBranch, deleteLatestAsBranch, editTurn, forkBranch, generateAlternative, generationBranchTurn, projectBranch, selectPage, type V4Branch } from '../src/v4/runtime/branches';
import { createV4Session, operateWorld } from '../src/v4/runtime/session';
import { generateV4Turn } from '../src/v4/runtime/engine';
import { compileV4Context } from '../src/v4/runtime/context';
import { acceptStateProposal } from '../src/v4/runtime/state-review';
import * as resolution from '../src/v4/runtime/resolution';
import { heuristicRelationshipScorer } from '../src/runtime/relationships/evaluator';
import type { ProviderAdapter, ProviderRequest } from '../src/runtime/providers/types';
import { v2Package } from './v2-fixtures';

afterEach(() => vi.restoreAllMocks());
function launch() {
  const pkg = v2Package();
  return publicV4Package({ ...pkg, relatedAssets: [...pkg.relatedAssets,
    { id: 'item:lantern', type: 'item', revision: 'r1', name: 'Lantern', summary: 'A brass lantern.', data: {} }] });
}
const root = () => createRootBranch(createV4Session(launch()));
function provider(text = '*The keeper checks the latch and looks toward the door.*') {
  return { kind: 'mock' as const, generate: vi.fn(async (_request: ProviderRequest) => ({ text,
    metadata: { provider: 'mock' as const, model: 'test', endpoint: 'mock:history', durationMs: 1, completionStatus: 'completed' as const } })) } satisfies ProviderAdapter;
}
async function generate(branch = root(), player = '*I wait for one minute.*', text?: string) {
  return generationBranchTurn({ ...branch, draft: player }, launch(), provider(text));
}
const active = (branch: V4Branch, index = branch.turns.length - 1) => branch.turns[index].pages.find((page) => page.id === branch.turns[index].activePageId)!;

describe('V4 alternatives, historical continuation, edits and forks', () => {
  it('adds inactive pages without changing authority, dice, time or permanent turn identity', async () => {
    const branch = await generate(root(), '*I rest for one hour.*');
    const original = JSON.stringify(branch);
    const old = active(branch);
    const resolver = vi.spyOn(resolution, 'resolveV4PlayerTurn');
    const alternative = await generateAlternative(branch, launch(), provider('*A bell rings outside the workshop.*'), branch.turns[0].id);
    expect(resolver).not.toHaveBeenCalled();
    expect(alternative.branchId).toBe(branch.branchId);
    expect(alternative.revision).toBe(branch.revision + 1);
    expect(alternative.turns[0].id).toBe(branch.turns[0].id);
    expect(alternative.turns[0].player).toBe(branch.turns[0].player);
    expect(alternative.turns[0].activePageId).toBe(old.id);
    expect(alternative.head).toEqual(branch.head);
    expect(alternative.frontier).toEqual(branch.frontier);
    expect(alternative.operations).toEqual(branch.operations);
    expect(alternative.draft).toBe(branch.draft);
    const page = alternative.turns[0].pages[1];
    expect(page.before).toEqual(old.before);
    expect(page.resolved).toEqual(old.resolved);
    expect(page.resolution).toEqual(old.resolution);
    expect(page.after!.world).toEqual(old.after!.world);
    expect(page.after!.nextTurn).toBe(old.after!.nextTurn);
    expect(page.source).toMatchObject({ kind: 'alternative', turnId: branch.turns[0].id, pageId: old.id });
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('selects latest pages by restoring the full outcome and page-scoped proposals', async () => {
    const branch = await generate(root(), '*I wait.*', '*You receive Lantern.*');
    const withAlternative = await generateAlternative(branch, launch(), provider('*You take Lantern.*'), branch.turns[0].id);
    const [old, page] = withAlternative.turns[0].pages;
    expect(old.after!.stateProposals[0].id).not.toBe(page.after!.stateProposals[0].id);
    expect(page.after!.stateProposals[0].sourcePageId).toBe(page.id);
    expect(page.after!.stateProposals[0].id).toContain(page.id);
    expect(withAlternative.head.stateProposals).toEqual(old.after!.stateProposals);
    const selected = selectPage(withAlternative, branch.turns[0].id, page.id);
    expect(selected.branchId).toBe(branch.branchId);
    expect(selected.head).toEqual(page.after);
    expect(selected.head.world).toEqual(branch.head.world);
    expect(selected.head.nextTurn).toBe(branch.head.nextTurn);
    expect(projectBranch(selected, launch()).turns[0].reply).toBe(page.reply);
    expect(selectPage(selected, branch.turns[0].id, old.id).head).toEqual(old.after);
  });

  it('excludes inactive prose and all descendants from every compiled memory tier', async () => {
    let branch = root();
    for (let index = 0; index < 21; index++) branch = await generate(branch, `*I examine prefix object ${index}.*`, `*PREFIX_${index} rests beside the workbench.*`);
    branch = await generateAlternative(branch, launch(), provider('*FORBIDDEN_INACTIVE sits beside the workbench.*'), branch.turns[4].id);
    branch = await generate(branch, '*I rest for one hour.*', '*FORBIDDEN_ORIGINAL_TARGET approaches.*');
    const targetIndex = branch.turns.length - 1;
    const targetId = branch.turns[targetIndex].id;
    let flat = projectBranch(branch, launch());
    flat = operateWorld(flat, { type: 'record-knowledge', actorId: flat.launch.persona.id, fact: 'FORBIDDEN_KNOWLEDGE' });
    flat.world.domains.chronicle.push({ id: 'later-chronicle', tier: 'archive', summary: 'FORBIDDEN_DOMAIN_CHRONICLE', atElapsedSeconds: flat.world.elapsedSeconds, sourceTurnIds: [targetId] });
    branch = captureBranchOperation(branch, flat, 'later knowledge');
    branch = await generate(branch, '*FORBIDDEN_DESCENDANT_PLAYER walks inside.*', '*FORBIDDEN_DESCENDANT_REPLY follows.*');
    const original = JSON.stringify(branch);
    const renderer = provider();
    const candidate = await generateAlternative(branch, launch(), renderer, targetId);
    const prompt = renderer.generate.mock.calls[0][0].prompt;
    expect(prompt).toContain('SESSION ARCHIVE RECAP');
    expect(prompt).toContain('SESSION CHRONICLE');
    expect(prompt).toContain('RECENT COMMITTED EXCHANGES');
    expect(prompt).not.toContain('FORBIDDEN_');
    const alternative = candidate.turns[targetIndex].pages.at(-1)!;
    expect(alternative.diagnostics.continuity!.latestCommittedTurnId).toBe(branch.turns[targetIndex - 1].id);
    expect(alternative.before!.events.filter((event) => event.kind === 'turn')).toHaveLength(targetIndex);
    expect(JSON.stringify(alternative.after)).not.toContain('FORBIDDEN_');
    expect(JSON.stringify(branch)).toBe(original);
    const child = selectPage(candidate, targetId, alternative.id);
    expect(child.parentBranchId).toBe(branch.branchId);
    expect(child.turns).toHaveLength(targetIndex + 1);
    expect(child.head).toEqual(alternative.after);
    expect(compileV4Context(projectBranch(child, launch()), '*I continue.*').prompt).not.toContain('FORBIDDEN_');
  });

  it('forks inactive outcomes without accepted page effects or later unrelated operations', async () => {
    let branch = await generate(root(), '*I wait.*', '*You receive Lantern.*');
    const targetId = branch.turns[0].id;
    branch = await generateAlternative(branch, launch(), provider('*The keeper closes the drawer.*'), targetId);
    const alternative = branch.turns[0].pages[1];
    let flat = projectBranch(branch, launch());
    flat = acceptStateProposal(flat, flat.stateProposals[0].id);
    branch = captureBranchOperation(branch, flat, 'accept lantern', { turnId: targetId, pageId: branch.turns[0].activePageId });
    flat = operateWorld(projectBranch(branch, launch()), { type: 'advance-clock', seconds: 300 });
    flat.world.domains.conditions.push({ id: 'treated-injury', definitionId: 'injury', actorId: flat.launch.persona.id, severity: 0.5, ownerTurnId: targetId });
    branch = captureBranchOperation(branch, flat, 'unrelated treatment');
    const expectedActiveBoundary = structuredClone(branch.head);
    branch = await generate(branch, '*I carry the lantern away.*', '*PARENT_FUTURE waits outside.*');
    const original = JSON.stringify(branch);
    const child = forkBranch(branch, targetId, alternative.id);
    expect(child.head).toEqual(alternative.after);
    expect(child.head.world.domains.inventory).toEqual([]);
    expect(child.head.world.domains.conditions).toEqual([]);
    expect(child.operations).toEqual([]);
    expect(child.turns).toHaveLength(1);
    expect(forkBranch(branch, targetId).head).toEqual(expectedActiveBoundary);
    expect(JSON.stringify(branch)).toBe(original);
    child.head.world.actors[0].knowledge.push('child only');
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('forks a latest replacement if trailing operations make switching unsafe', async () => {
    let branch = await generate();
    const id = branch.turns[0].id;
    branch = await generateAlternative(branch, launch(), provider('*Another bell rings.*'), id);
    branch = captureBranchOperation(branch, operateWorld(projectBranch(branch, launch()), { type: 'advance-clock', seconds: 500 }), 'later operator');
    const original = JSON.stringify(branch);
    const child = selectPage(branch, id, branch.turns[0].pages[1].id);
    expect(child.branchId).not.toBe(branch.branchId);
    expect(child.parentBranchId).toBe(branch.branchId);
    expect(child.head.world.elapsedSeconds).toBe(active(branch).after!.world.elapsedSeconds);
    expect(child.operations).toEqual([]);
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('changes latest input with new resolution while retaining and restoring old page input', async () => {
    const branch = await generate();
    const original = JSON.stringify(branch);
    const turn = branch.turns[0];
    const resolver = vi.spyOn(resolution, 'resolveV4PlayerTurn');
    const edited = await editTurn(branch, launch(), provider(), turn.id, { player: '*I wait for one hour.*' });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(edited.branchId).toBe(branch.branchId);
    expect(edited.turns[0].id).toBe(turn.id);
    expect(edited.turns[0].pages).toHaveLength(2);
    expect(edited.head.world.elapsedSeconds).toBe(3600);
    expect(active(edited).source!.kind).toBe('input-edit');
    expect(edited.turns[0].pages[0].player).toBe(turn.player);
    const restored = selectPage(edited, turn.id, turn.activePageId);
    expect(restored.turns[0].player).toBe(turn.player);
    expect(projectBranch(restored, launch()).turns[0].player).toBe(turn.player);
    expect(restored.head.world.elapsedSeconds).toBe(60);
    expect(restored.head.nextTurn).toBe(branch.head.nextTurn);
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('always forks older input edits, retaining turn identity and excluding the old future', async () => {
    let branch = await generate();
    const id = branch.turns[0].id;
    branch = await generate(branch, '*I thank you.*', '*FORBIDDEN_FUTURE descends.*');
    const original = JSON.stringify(branch);
    const renderer = provider();
    const child = await editTurn(branch, launch(), renderer, id, { player: '*I wait for two hours.*' });
    expect(child.parentBranchId).toBe(branch.branchId);
    expect(child.turns).toHaveLength(1);
    expect(child.turns[0].id).toBe(id);
    expect(child.turns[0].pages).toHaveLength(2);
    expect(child.head.world.elapsedSeconds).toBe(7200);
    expect(renderer.generate.mock.calls[0][0].prompt).not.toContain('FORBIDDEN_FUTURE');
    expect(Object.values(child.head.relationships).flatMap((record) => record.events).some((event) => event.turnId === branch.turns[1].id)).toBe(false);
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('reply-only editing validates/normalizes locally and recomputes effects without dice/provider calls', async () => {
    const scorer = vi.spyOn(heuristicRelationshipScorer, 'evaluate').mockImplementation(({ characterReply }) => ({
      delta: characterReply.includes('gentle') ? 9 : 3, reason: 'reply-dependent test scorer', dimensionDeltas: { trust: 1 },
    }));
    const branch = await generate(root(), '*I rest for one hour.*', '*You receive Lantern.*');
    const before = active(branch);
    const resolver = vi.spyOn(resolution, 'resolveV4PlayerTurn');
    scorer.mockClear();
    const renderer = provider();
    const edited = await editTurn(branch, launch(), renderer, branch.turns[0].id, { reply: 'The gentle keeper closes the drawer. "Stay here."' });
    expect(renderer.generate).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(scorer).toHaveBeenCalledTimes(1);
    expect(active(edited).reply).toContain('*The gentle keeper closes the drawer.*');
    expect(active(edited).resolution).toEqual(before.resolution);
    expect(edited.head.world).toEqual(branch.head.world);
    expect(edited.head.stateProposals).toEqual([]);
    const record = Object.values(edited.head.relationships)[0];
    expect(record.score).toBe(9);
    expect(record.events).toHaveLength(1);
    expect(record.events[0].turnId).toBe(branch.turns[0].id);
    expect(active(edited).diagnostics.providerEndpoint).toBe('local-reply-edit');
    expect(active(edited).source!.kind).toBe('reply-edit');
  });

  it('reply-only edits fork away from accepted page proposals and later physical state', async () => {
    let branch = await generate(root(), '*I wait.*', '*You receive Lantern.*');
    const old = active(branch);
    const flat = acceptStateProposal(projectBranch(branch, launch()), branch.head.stateProposals[0].id);
    branch = captureBranchOperation(branch, flat, 'accept lantern', { turnId: branch.turns[0].id, pageId: old.id });
    const original = JSON.stringify(branch);
    const edited = await editTurn(branch, launch(), provider(), branch.turns[0].id, { reply: '*You receive Lantern.*' });
    expect(edited.parentBranchId).toBe(branch.branchId);
    expect(edited.head.world.domains.inventory).toEqual([]);
    expect(edited.head.stateProposals).toHaveLength(1);
    expect(edited.head.stateProposals[0].id).not.toBe(old.after!.stateProposals[0].id);
    expect(edited.head.stateProposals[0].sourcePageId).toBe(active(edited).id);
    expect(edited.operations).toEqual([]);
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('permits authorization-expired local reply edits but not re-resolution or provider generation', async () => {
    const branch = await generate();
    const expired = { ...launch(), expiresAt: 1 };
    const renderer = provider();
    const resolver = vi.spyOn(resolution, 'resolveV4PlayerTurn');
    const edited = await editTurn(branch, expired, renderer, branch.turns[0].id, { reply: '*The keeper closes the door.*' });
    expect(edited.head.world).toEqual(branch.head.world);
    expect(renderer.generate).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    await expect(editTurn(branch, expired, renderer, branch.turns[0].id, { player: '*I wait for one hour.*' })).rejects.toThrow('expired');
    await expect(generateAlternative(branch, expired, renderer, branch.turns[0].id)).rejects.toThrow('expired');
    await expect(editTurn(branch, { ...expired, primaryAsset: { ...expired.primaryAsset, revision: 'different-source' } }, renderer,
      branch.turns[0].id, { reply: '*The keeper closes the door.*' })).rejects.toThrow('source');
  });

  it('historical reply edits retain original pages but never restore old future effects', async () => {
    let branch = await generate(root(), '*I wait.*', '*You receive Lantern.*');
    const target = branch.turns[0];
    branch = await generate(branch, '*I wait for one hour.*', '*FORBIDDEN_REPLY_EDIT_FUTURE approaches.*');
    const original = JSON.stringify(branch);
    const edited = await editTurn(branch, launch(), provider(), target.id, { reply: '*The drawer remains shut.*' });
    expect(edited.parentBranchId).toBe(branch.branchId);
    expect(edited.turns).toHaveLength(1);
    expect(edited.turns[0].pages[0].reply).toBe(target.pages[0].reply);
    expect(edited.head.world).toEqual(target.pages[0].after!.world);
    expect(edited.head.stateProposals).toEqual([]);
    expect(compileV4Context(projectBranch(edited, launch()), '*I continue.*').prompt).not.toContain('FORBIDDEN_REPLY_EDIT_FUTURE');
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('keeps original branches unchanged on rejected replies, provider failures and cancellations', async () => {
    const branch = await generate();
    const id = branch.turns[0].id;
    const original = JSON.stringify(branch);
    const broken = provider();
    broken.generate.mockRejectedValue(new Error('network failed'));
    await expect(generateAlternative(branch, launch(), broken, id)).rejects.toThrow('network failed');
    await expect(editTurn(branch, launch(), broken, id, { player: '*I wait for one hour.*' })).rejects.toThrow('network failed');
    await expect(editTurn(branch, launch(), provider(), id, { reply: '<state_patch>invented state</state_patch>' })).rejects.toThrow('rejected');
    await expect(generateAlternative(branch, launch(), provider(), id, { signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    const controller = new AbortController();
    await expect(editTurn(branch, launch(), provider(), id, { reply: '*A bell rings.*', signal: controller.signal,
      onPhase: (phase) => { if (phase === 'commit') controller.abort(); } })).rejects.toThrow('cancelled');
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('fails closed for unknown pages, unverifiable imports, stale authorization and ambiguous edits', async () => {
    const flat = await generateV4Turn({ ...createV4Session(launch()), draft: '*I wait.*' }, provider());
    const imported = createRootBranch(flat);
    await expect(generateAlternative(imported, launch(), provider(), flat.turns[0].id)).rejects.toThrow('unverifiable');
    await expect(editTurn(imported, launch(), provider(), flat.turns[0].id, { reply: '*Hello.*' })).rejects.toThrow('unverifiable');
    expect(() => deleteLatestAsBranch(imported)).toThrow('unverifiable');
    const branch = await generate();
    expect(() => selectPage(branch, branch.turns[0].id, 'missing')).toThrow('not in');
    await expect(generateAlternative(branch, { ...launch(), expiresAt: 1 }, provider(), branch.turns[0].id)).rejects.toThrow('expired');
    await expect(editTurn(branch, launch(), provider(), branch.turns[0].id, { player: '*new input*', reply: '*new reply*' })).rejects.toThrow('separately');
  });

  it('validates history identities, reuse linkage and proposal provenance', async () => {
    const first = await generate(root(), '*I wait.*', '*You receive Lantern.*');
    await expect(generateAlternative(first, launch(), provider(), 'missing')).rejects.toThrow('not in');
    const candidate = await generateAlternative(first, launch(), provider('*You receive Lantern.*'), first.turns[0].id);
    for (const mutate of [
      (value: V4Branch) => { value.turns[0].pages[1].source!.pageId = 'missing'; },
      (value: V4Branch) => { value.turns[0].pages[1].diagnostics.history!.pageId = 'missing'; },
      (value: V4Branch) => { value.turns[0].pages[1].player = '*changed input under alternative*'; },
      (value: V4Branch) => { value.turns[0].pages[1].after!.stateProposals[0].sourcePageId = value.turns[0].pages[0].id; },
    ]) {
      const invalid = structuredClone(candidate); mutate(invalid);
      expect(branchSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('deletes latest only into a child before boundary, preserving operations and allocating a new ID', async () => {
    let branch = await generate();
    branch = captureBranchOperation(branch, operateWorld(projectBranch(branch, launch()), { type: 'advance-clock', seconds: 400 }), 'before latest');
    const before = structuredClone(branch.head);
    branch = await generate(branch, '*I wait for two hours.*');
    const removed = branch.turns[1];
    const original = JSON.stringify(branch);
    const child = deleteLatestAsBranch(branch);
    expect(child.head).toEqual(before);
    expect(child.turns).toHaveLength(1);
    expect(child.operations).toHaveLength(1);
    expect(child.draft).toBe(removed.player);
    expect(child.parentBranchId).toBe(branch.branchId);
    const next = await generationBranchTurn(child, launch(), provider());
    expect(next.turns[1].id).not.toBe(removed.id);
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('supports deleting the first verifiable turn into an empty child with pre-turn operations', async () => {
    let branch = root();
    branch = captureBranchOperation(branch, operateWorld(projectBranch(branch, launch()), { type: 'advance-clock', seconds: 90 }), 'initial operator');
    const before = structuredClone(branch.head);
    branch = await generate(branch);
    const child = deleteLatestAsBranch(branch);
    expect(child.turns).toEqual([]);
    expect(child.head).toEqual(before);
    expect(child.forkTurnId).toBeNull();
    expect(child.forkPageId).toBeNull();
    expect(child.frontier).toBeNull();
    expect(child.operations).toHaveLength(1);
  });

  it('preserves skipped-persona resolution and input without advancing time', async () => {
    const branch = await generationBranchTurn(root(), launch(), provider(), { skipAsActorId: launch().character!.id });
    const resolver = vi.spyOn(resolution, 'resolveV4PlayerTurn');
    const alternative = await generateAlternative(branch, launch(), provider(), branch.turns[0].id);
    expect(resolver).not.toHaveBeenCalled();
    expect(alternative.turns[0].pages[1].player).toBe(branch.turns[0].player);
    expect(alternative.turns[0].pages[1].resolution).toEqual(active(branch).resolution);
    expect(selectPage(alternative, branch.turns[0].id, alternative.turns[0].pages[1].id).head.world.elapsedSeconds).toBe(0);
  });
});
