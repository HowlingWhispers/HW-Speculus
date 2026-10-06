import { describe, expect, it, vi } from 'vitest';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createV4Session, operateWorld } from '../src/v4/runtime/session';
import { branchSchema, captureBranchOperation, createRootBranch, forkBranch, generationBranchTurn, projectBranch } from '../src/v4/runtime/branches';
import { generateV4Turn } from '../src/v4/runtime/engine';
import * as resolution from '../src/v4/runtime/resolution';
import { MockProvider } from '../src/runtime/providers/mock';
import { v2Package } from './v2-fixtures';

const fresh = () => createV4Session(publicV4Package(v2Package()));
const root = () => createRootBranch(fresh());
const generate = (branch = root(), draft = '*I wait for one minute.*') => generationBranchTurn({ ...branch, draft }, fresh().launch, new MockProvider());

describe('V4 canonical branches and complete boundaries', () => {
  it('keeps source/story/root identity independent of authorization and projections', () => {
    const flat = fresh(), branch = createRootBranch(flat);
    expect(branch.storyId).toBe(flat.id);
    expect(branch.branchId).not.toBe(flat.id);
    expect(branch).not.toHaveProperty('launch');
    expect(branch.source).toMatchObject({ sourceId: flat.launch.primaryAsset.id, personaId: flat.launch.persona.id });
    const projected = projectBranch(branch, flat.launch);
    projected.world.actors[0].knowledge.push('mutated projection');
    expect(branch.head.world.actors[0].knowledge).not.toContain('mutated projection');
    expect(() => projectBranch(branch, { ...flat.launch, persona: { ...flat.launch.persona, id: 'wrong-persona' } })).toThrow('source');
  });

  it('allows an explicit before-first-turn child for conflict preservation', () => {
    const parent = root();
    const child = { ...parent, branchId: crypto.randomUUID(), parentBranchId: parent.branchId, lineage: [parent.branchId] };
    expect(branchSchema.safeParse(child).success).toBe(true);
    expect(projectBranch(child, fresh().launch).turns).toEqual([]);
    expect(branchSchema.safeParse({ ...child, forkTurnId: 'missing' }).success).toBe(false);
  });

  it('captures complete new checkpoints, trusted resolution and globally unique turns', async () => {
    const branch = await generate();
    const page = branch.turns[0].pages[0];
    expect(page.before!.world.elapsedSeconds).toBe(0);
    expect(page.resolution!.elapsedSeconds).toBe(60);
    expect(page.resolved!.world.elapsedSeconds).toBe(60);
    expect(page.after!.world.elapsedSeconds).toBe(60);
    expect(page.after!.nextTurn).toBe(2);
    expect(Object.keys(page.after!.world.domains).sort()).toEqual(['chronicle', 'conditions', 'inventory', 'mysteries', 'relationships', 'resources']);
    expect(projectBranch(branch, fresh().launch).turns[0].reply).toBe(page.reply);
    const fork = forkBranch(branch, branch.turns[0].id);
    const [left, right] = await Promise.all([generate(branch), generate(fork)]);
    expect(left.turns[1].id).not.toBe(right.turns[1].id);
    expect(left.turns[1].id).toMatch(/^v4:[a-f0-9-]{36}$/);
  });

  it('forks after a turn including operations before the next turn, excluding every descendant', async () => {
    let branch = await generate();
    const first = branch.turns[0];
    let flat = projectBranch(branch, fresh().launch);
    flat = operateWorld(flat, { type: 'record-knowledge', actorId: flat.launch.persona.id, fact: 'prefix knowledge' });
    flat.world.domains.resources.push({ id: 'energy', definitionId: 'energy', ownerActorId: flat.launch.persona.id, value: 7, maximum: 10 });
    branch = captureBranchOperation(branch, flat, 'prefix operation');
    const boundary = structuredClone(branch.head);
    branch = await generate(branch, '*I rest for one hour.*');
    flat = projectBranch(branch, fresh().launch);
    flat = operateWorld(flat, { type: 'record-knowledge', actorId: flat.launch.persona.id, fact: 'FORBIDDEN DESCENDANT' });
    flat.world.domains.conditions.push({ id: 'injury', definitionId: 'injury', actorId: flat.launch.persona.id, severity: 1, ownerTurnId: branch.turns[1].id });
    flat.world.domains.chronicle.push({ id: 'future', tier: 'archive', summary: 'FORBIDDEN DESCENDANT', atElapsedSeconds: flat.world.elapsedSeconds, sourceTurnIds: [branch.turns[1].id] });
    branch = captureBranchOperation(branch, flat, 'unrelated later operation');
    const original = JSON.stringify(branch);
    const fork = forkBranch(branch, first.id);
    expect(fork.head).toEqual(boundary);
    expect(fork.turns).toHaveLength(1);
    expect(fork.operations).toHaveLength(1);
    expect(fork.lineage).toEqual([branch.branchId]);
    expect(fork.parentBranchId).toBe(branch.branchId);
    expect(JSON.stringify(fork)).not.toContain('FORBIDDEN DESCENDANT');
    fork.head.world.domains.resources[0].value = 1;
    fork.turns[0].pages[0].after!.world.actors[0].knowledge.push('child only');
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('records proposal rejection even when world revision does not change', async () => {
    let branch = await generate();
    let flat = projectBranch(branch, fresh().launch);
    flat.stateProposals = [{ id: 'proposal', sourceTurnId: branch.turns[0].id, kind: 'inventory-remove', summary: 'remove', instanceId: 'item' }];
    branch = captureBranchOperation(branch, flat, 'pending review');
    flat = projectBranch(branch, fresh().launch);
    flat.stateProposals = [];
    branch = captureBranchOperation(branch, flat, 'reject proposal', { turnId: branch.turns[0].id, pageId: branch.turns[0].activePageId });
    expect(branch.operations).toHaveLength(2);
    expect(branch.operations[1].before.stateProposals).toHaveLength(1);
    expect(branch.operations[1].after.stateProposals).toEqual([]);
    expect(forkBranch(branch, branch.turns[0].id).head).toEqual(branch.head);
  });

  it('preserves imported flat transcript/current state without fabricating history', async () => {
    const imported = await generateV4Turn({ ...fresh(), draft: '*I wait.*' }, new MockProvider());
    const branch = createRootBranch(imported);
    expect(branch.turns[0].pages[0]).toMatchObject({ before: null, resolved: null, after: null, resolution: null });
    expect(projectBranch(branch, imported.launch)).toEqual(imported);
    expect(() => forkBranch(branch, imported.turns[0].id)).toThrow('unverifiable');
    const next = await generate(branch);
    expect(next.turns[1].pages[0].before).toEqual(branch.head);
    expect(forkBranch(next, next.turns[1].id).head).toEqual(next.head);
  });

  it('keeps failure and cancellation from mutating the original branch', async () => {
    const branch = { ...root(), draft: '*I wait.*' };
    const original = JSON.stringify(branch);
    const provider = new MockProvider();
    vi.spyOn(provider, 'generate').mockRejectedValue(new Error('provider down'));
    await expect(generationBranchTurn(branch, fresh().launch, provider)).rejects.toThrow('provider down');
    await expect(generationBranchTurn(branch, fresh().launch, provider, { signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(JSON.stringify(branch)).toBe(original);
    const controller = new AbortController();
    await expect(generationBranchTurn(branch, fresh().launch, new MockProvider(), {
      signal: controller.signal, onPhase: (phase) => { if (phase === 'commit') controller.abort(); },
    })).rejects.toThrow('cancelled');
    expect(JSON.stringify(branch)).toBe(original);
  });

  it('reuses a recorded resolved checkpoint and exact dice without calling the resolver', async () => {
    const branch = await generate(root(), '*I rest for one hour.*');
    const page = branch.turns[0].pages[0];
    const before = projectBranch({ ...root(), storyId: branch.storyId, draft: branch.turns[0].player }, fresh().launch);
    const resolvedSession = { ...structuredClone(before), ...structuredClone(page.resolved!) };
    const spy = vi.spyOn(resolution, 'resolveV4PlayerTurn');
    try {
      const next = await generateV4Turn(before, new MockProvider(), { recordedResolution: { resolution: page.resolution!, resolvedSession } });
      expect(spy).not.toHaveBeenCalled();
      expect(next.world).toEqual(page.after!.world);
      expect(next.turns[0].diagnostics.resolutionCheck).toEqual(page.resolution!.narrativeCheck);
      expect(next.turns[0].diagnostics.resolutionElapsedSeconds).toBe(page.resolution!.elapsedSeconds);
    } finally { spy.mockRestore(); }
  });

  it('rejects bad membership, duplicate identities, frontier and head inconsistencies', async () => {
    const branch = await generate();
    for (const mutate of [
      (value: typeof branch) => { value.turns[0].activePageId = 'missing'; },
      (value: typeof branch) => { value.turns[0].pages.push(structuredClone(value.turns[0].pages[0])); },
      (value: typeof branch) => { value.frontier = null; },
      (value: typeof branch) => { value.head.nextTurn += 1; },
      (value: typeof branch) => { value.lineage = [value.branchId]; },
      (value: typeof branch) => { value.turns[0].pages[0].resolved!.world.revision += 1; },
      (value: typeof branch) => { value.turns[0].pages[0].before = null; },
      (value: typeof branch) => { value.turns[0].pages[0].diagnostics.worldRevision += 1; },
      (value: typeof branch) => { value.turns[0].pages[0].resolution!.playerPerception.knownFacts.push('unrecorded'); },
      (value: typeof branch) => { value.turns[0].pages[0].resolution!.elapsedSeconds += 1; },
    ]) {
      const broken = structuredClone(branch); mutate(broken);
      expect(branchSchema.safeParse(broken).success).toBe(false);
    }
  });

  it('rejects missing domain checkpoints rather than inventing defaults', async () => {
    const branch = await generate();
    const raw = JSON.parse(JSON.stringify(branch));
    delete raw.turns[0].pages[0].before.world.domains.resources;
    expect(branchSchema.safeParse(raw).success).toBe(false);
    const missing = JSON.parse(JSON.stringify(branch));
    delete missing.turns[0].pages[0].after.stateProposals;
    expect(branchSchema.safeParse(missing).success).toBe(false);
  });

  it('validates actor references in every non-inventory domain', () => {
    for (const domain of ['conditions', 'resources', 'relationships', 'mysteries'] as const) {
      const branch = root();
      for (const snapshot of [branch.initial, branch.head]) {
        if (domain === 'conditions') snapshot.world.domains.conditions.push({ id: 'bad', definitionId: 'bad', actorId: 'unpackaged', severity: null, ownerTurnId: null });
        if (domain === 'resources') snapshot.world.domains.resources.push({ id: 'bad', definitionId: 'bad', ownerActorId: 'unpackaged', value: 1, maximum: null });
        if (domain === 'relationships') snapshot.world.domains.relationships.push({ id: 'bad', actorIds: ['unpackaged', branch.source.personaId], stage: null, factors: {}, events: [] });
        if (domain === 'mysteries') snapshot.world.domains.mysteries.push({ id: 'bad', mysteryId: 'bad', stageIndex: 0, knownByActorIds: ['unpackaged'], revealedFactIds: [] });
      }
      expect(() => projectBranch(branch, fresh().launch)).toThrow('unpackaged actor');
    }
  });

  it('rejects operation allocation changes and recorded-resolution boundary substitution', async () => {
    const branch = await generate();
    const flat = projectBranch(branch, fresh().launch);
    flat.nextTurn += 1;
    expect(() => captureBranchOperation(branch, flat, 'bad allocation')).toThrow();
    const page = branch.turns[0].pages[0];
    const before = fresh();
    const resolvedSession = { ...before, ...page.resolved!, id: 'other-story' };
    const provider = new MockProvider();
    const spy = vi.spyOn(provider, 'generate');
    await expect(generateV4Turn({ ...before, draft: '*I wait.*' }, provider, {
      recordedResolution: { resolution: page.resolution!, resolvedSession },
    })).rejects.toThrow('boundary');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects checkpoint canon mismatches and history mutation via operations', async () => {
    const branch = await generate();
    const broken = structuredClone(branch);
    broken.turns[0].pages[0].before!.world.actors[0].id = 'unpackaged';
    expect(() => projectBranch(broken, fresh().launch)).toThrow();
    const flat = projectBranch(branch, fresh().launch);
    flat.turns[0].reply = '*changed*';
    expect(() => captureBranchOperation(branch, flat, 'bad')).toThrow('history');
  });

  it('rejects descendant state hidden in a linked historical boundary', async () => {
    const first = await generate();
    const branch = await generate(first);
    const descendant = branch.turns[1].id;
    const inject = (snapshot: typeof branch.head) => snapshot.world.domains.chronicle.push({ id: 'contamination', tier: 'archive', summary: 'future', atElapsedSeconds: 0, sourceTurnIds: [descendant] });
    inject(branch.turns[0].pages[0].after!);
    inject(branch.turns[0].pages[0].resolved!);
    inject(branch.turns[1].pages[0].before!);
    inject(branch.turns[1].pages[0].resolved!);
    inject(branch.turns[1].pages[0].after!);
    inject(branch.head);
    expect(branchSchema.safeParse(branch).success).toBe(false);
  });
});
