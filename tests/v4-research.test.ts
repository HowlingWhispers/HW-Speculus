import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createV4Session } from '../src/v4/runtime/session';
import { createRootBranch, forkBranch, generationBranchTurn, type V4Branch } from '../src/v4/runtime/branches';
import { MockProvider } from '../src/runtime/providers/mock';
import { retractBranchTurnFromStudium, retractLatestTurnFromStudium, submitBranchTurnToStudium, submitLatestTurnToStudium } from '../src/v4/research/studium';
import { v2Package } from './v2-fixtures';

const launch = () => publicV4Package(v2Package());
async function fixture() {
  const authorized = launch();
  const root = createRootBranch(createV4Session(authorized));
  const branch = await generationBranchTurn({ ...root, draft: '*I wait.*' }, authorized, new MockProvider());
  return { branch, authorized, turn: branch.turns[0] };
}
const accepted = () => new Response(null, { status: 202 });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function requests(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map(([path, options]) => ({ path, options, body: JSON.parse(options.body) }));
}

describe('V4 branch-scoped Studium client', () => {
  it('submits the selected page with canonical identity and only authorized transport metadata', async () => {
    const { branch, authorized, turn } = await fixture();
    const fetch = vi.fn().mockResolvedValue(accepted()); vi.stubGlobal('fetch', fetch);
    const inactive = structuredClone(turn.pages[0]); inactive.id = 'inactive:page'; inactive.reply = 'FORBIDDEN INACTIVE REPLY';
    if (inactive.diagnostics.history) {
      inactive.diagnostics.history.pageId = inactive.diagnostics.history.frontierPageId = inactive.id;
    }
    turn.pages.push(inactive);
    await submitLatestTurnToStudium(branch, authorized);
    const [request] = requests(fetch);
    expect(request.path).toBe('/api/v4/research');
    expect(request.options.credentials).toBe('same-origin');
    expect(request.body).toEqual({
      launchId: authorized.launchId, storyId: branch.storyId, branchId: branch.branchId, turnId: turn.id, pageId: turn.activePageId,
      occurredAt: turn.pages[0].createdAt, player: turn.player, reply: turn.pages[0].reply, worldRevision: turn.pages[0].worldRevision,
      locationId: turn.pages[0].after!.world.locationId, engine: 'v4',
    });
    expect(JSON.stringify(request)).not.toContain('FORBIDDEN');
    expect(request.body).not.toHaveProperty('sessionId');
    expect(request.body).not.toHaveProperty('generationGrant');
    expect(request.body).not.toHaveProperty('expiresAt');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serializes a delayed old submission, retraction and replacement using invocation-time snapshots', async () => {
    const { branch, authorized, turn } = await fixture();
    let release!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; })).mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetch);
    const originalReply = turn.pages[0].reply;
    const old = submitBranchTurnToStudium(branch, authorized);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const retract = retractBranchTurnFromStudium(branch, authorized, turn.id);
    const replacement = structuredClone(branch); const selected = replacement.turns[0];
    selected.pages[0].id = selected.activePageId = 'new:selected:page'; selected.pages[0].reply = 'Replacement reply';
    if (selected.pages[0].diagnostics.history) {
      selected.pages[0].diagnostics.history!.pageId = selected.pages[0].diagnostics.history!.frontierPageId = selected.activePageId;
    }
    replacement.frontier!.pageId = selected.activePageId;
    const next = submitBranchTurnToStudium(replacement, authorized);
    selected.pages[0].reply = 'MUTATED AFTER INVOCATION';
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    release(accepted()); await Promise.all([old, retract, next]);
    const recorded = requests(fetch);
    expect(recorded.map((value) => value.path)).toEqual(['/api/v4/research', '/api/v4/research/retract', '/api/v4/research']);
    expect(recorded[0].body.reply).toBe(originalReply);
    expect(recorded[2].body).toMatchObject({ pageId: 'new:selected:page', reply: 'Replacement reply' });
    expect(recorded.map(({ body }) => [body.storyId, body.branchId, body.turnId])).toEqual(Array(3).fill([branch.storyId, branch.branchId, turn.id]));
  });

  it('leaves retraction last when a pending submission completes late', async () => {
    const { branch, authorized } = await fixture();
    let release!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; })).mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetch);
    const submit = submitLatestTurnToStudium(branch, authorized);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const retract = retractLatestTurnFromStudium(branch, authorized);
    expect(fetch).toHaveBeenCalledTimes(1);
    release(accepted()); await Promise.all([submit, retract]);
    expect(requests(fetch).at(-1)?.path).toBe('/api/v4/research/retract');
  });

  it('queues child research independently and never retracts the parent bundle', async () => {
    const { branch, authorized, turn } = await fixture();
    const child = forkBranch(branch, turn.id);
    const before = JSON.stringify(branch);
    const fetch = vi.fn().mockResolvedValue(accepted()); vi.stubGlobal('fetch', fetch);
    expect(fetch).not.toHaveBeenCalled();
    await submitLatestTurnToStudium(branch, authorized);
    await submitLatestTurnToStudium(child, authorized);
    await retractLatestTurnFromStudium(child, authorized);
    const recorded = requests(fetch);
    expect(recorded.map(({ body }) => body.branchId)).toEqual([branch.branchId, child.branchId, child.branchId]);
    expect(recorded[2].body).toMatchObject({ storyId: branch.storyId, turnId: turn.id, pageId: turn.activePageId, engine: 'v4' });
    expect(JSON.stringify(branch)).toBe(before);
  });

  it('does not block other branches or collide ambiguous colon-delimited identities', async () => {
    const { branch, authorized, turn } = await fixture();
    const left = { ...structuredClone(branch), storyId: 'a:b', branchId: 'c' };
    const right = { ...structuredClone(branch), storyId: 'a', branchId: 'b:c' };
    for (const value of [left, right]) {
      if (value.turns[0].pages[0].diagnostics.history) value.turns[0].pages[0].diagnostics.history!.branchId = value.branchId;
    }
    const child = forkBranch(branch, turn.id);
    let release!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; })).mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetch);
    const blocked = submitLatestTurnToStudium(left, authorized);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await submitLatestTurnToStudium(right, authorized);
    await submitLatestTurnToStudium(child, authorized);
    await retractLatestTurnFromStudium(child, authorized);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(requests(fetch).slice(1).map(({ body }) => body.branchId)).toEqual(['b:c', child.branchId, child.branchId]);
    release(accepted()); await blocked;
  });

  it('does not let a failed request block a queued retraction or expose upstream credentials', async () => {
    const { branch, authorized } = await fixture();
    const fetch = vi.fn().mockResolvedValueOnce(new Response('PRIVATE TOKEN', { status: 502 })).mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetch);
    const failed = submitLatestTurnToStudium(branch, authorized);
    const assertion = expect(failed).rejects.toThrow('HTTP 502');
    const retract = retractLatestTurnFromStudium(branch, authorized);
    await assertion; await retract;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects mismatched launch/source and missing turn or page without contacting the bridge', async () => {
    const { branch, authorized } = await fixture();
    const fetch = vi.fn().mockResolvedValue(accepted()); vi.stubGlobal('fetch', fetch);
    await expect(submitLatestTurnToStudium(branch, { ...authorized, persona: { ...authorized.persona, id: 'wrong' } })).rejects.toThrow('source');
    await expect(submitBranchTurnToStudium(branch, authorized, 'missing')).rejects.toThrow('member');
    await expect(retractBranchTurnFromStudium(branch, authorized, 'missing')).rejects.toThrow('page identity');
    expect(fetch).not.toHaveBeenCalled();
    const empty: V4Branch = createRootBranch(createV4Session(authorized));
    await submitLatestTurnToStudium(empty, authorized); await retractLatestTurnFromStudium(empty, authorized);
    expect(fetch).not.toHaveBeenCalled();
    await retractBranchTurnFromStudium(empty, authorized, 'removed-turn', 'removed-page');
    expect(requests(fetch)[0].body).toMatchObject({ turnId: 'removed-turn', pageId: 'removed-page', branchId: empty.branchId });
  });
});
