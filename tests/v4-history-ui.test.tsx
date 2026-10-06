import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V4App as AppComponent } from '../src/v4/ui/App';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createV4Session } from '../src/v4/runtime/session';
import { createBranchRepository } from '../src/v4/storage/branches';
import { saveV4Authorization } from '../src/v4/storage/authorization';
import { exportBranch, importBranchFile } from '../src/v4/storage/branch-transfer';
import { IndexedDBDouble } from './v4-indexeddb-fixture';
import { v2Package } from './v2-fixtures';

let App: typeof AppComponent;
let db: IndexedDBDouble;
let repo: ReturnType<typeof createBranchRepository>;
let generation: ReturnType<typeof vi.fn>;
let research: ReturnType<typeof vi.fn>;
let speak: ReturnType<typeof vi.fn>;
const launch = publicV4Package(v2Package());
const firstReply = '*She nods.* "First minute recorded."';
const futureReply = '*She looks up.* "Original future remains here."';
const alternativeReply = '*She smiles.* "Alternative first minute."';

function response(text: string) {
  return new Response(JSON.stringify({ text, metadata: { provider: 'orbis', model: 'mock', durationMs: 1, completionStatus: 'stop' } }), { status: 200 });
}
beforeEach(async () => {
  vi.resetModules();
  sessionStorage.clear(); localStorage.clear(); history.replaceState({}, '', '/v4');
  db = new IndexedDBDouble();
  repo = createBranchRepository({ indexedDB: db.factory });
  vi.stubGlobal('indexedDB', db.factory);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  speak = vi.fn();
  vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn(), getVoices: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
  generation = vi.fn(async () => response(alternativeReply));
  research = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/v4/generate') return generation(input, init);
    if (url.startsWith('/api/v4/research')) return research(input, init);
    throw new Error(`Unexpected history test request: ${url}`);
  }));
  saveV4Authorization(createV4Session(launch).launch);
  ({ V4App: App } = await import('../src/v4/ui/App'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function active() {
  const value = await repo.loadActiveBranch();
  if (!value) throw new Error('No durable branch was committed.');
  return value.branch;
}
function pages(turn: number) { return within(screen.getByRole('group', { name: `Turn ${turn} pages` })); }
async function idle() {
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
}
async function twoTurns() {
  const view = render(<App />);
  await screen.findByLabelText('Your next turn');
  for (const [index, input, reply] of [[1, '*I wait for one minute.*', firstReply], [2, '*I wait for two minutes.*', futureReply]] as const) {
    generation.mockResolvedValueOnce(response(reply));
    fireEvent.change(screen.getByLabelText('Your next turn'), { target: { value: input } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('group', { name: `Turn ${index} pages` });
    await idle();
    await waitFor(() => expect(research).toHaveBeenCalledTimes(index));
  }
  const original = await active();
  expect(original.turns).toHaveLength(2);
  generation.mockClear(); research.mockClear(); speak.mockClear();
  return { original, view };
}
async function alternative(turn = 1) {
  fireEvent.click(screen.getByRole('button', { name: `Generate alternative for turn ${turn}` }));
  await waitFor(() => expect(pages(turn).getByText('Page 2 / 2 / Preview only')).toBeInTheDocument());
  await idle();
  return active();
}
async function edit(turn: number, scope: 'reply' | 'input', text: string) {
  fireEvent.click(screen.getByRole('button', { name: `Edit turn ${turn}` }));
  fireEvent.change(screen.getByLabelText('Edit scope'), { target: { value: scope } });
  fireEvent.change(screen.getByLabelText(scope === 'reply' ? 'Edited reply' : 'Edited player input'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm edit' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit historical turn' })).toBeNull());
  await idle();
  return active();
}

describe('V4 transactional history UI', () => {
  it('adds an inactive historical page without changing head, frontier, input or parent future; arrows are preview only', async () => {
    const { original } = await twoTurns();
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read new replies aloud' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Read new replies aloud' })).toBeChecked());
    const before = await active();
    const saved = await alternative();
    expect(saved.branchId).toBe(original.branchId);
    expect(saved.head).toEqual(before.head);
    expect(saved.frontier).toEqual(before.frontier);
    expect(saved.turns[0].activePageId).toBe(before.turns[0].activePageId);
    expect(saved.turns[0].pages[0]).toEqual(before.turns[0].pages[0]);
    expect(saved.turns[0].pages[1].resolution).toEqual(before.turns[0].pages[0].resolution);
    expect(saved.turns[0].pages[1].resolved?.world).toEqual(before.turns[0].pages[0].resolved?.world);
    expect(saved.turns[1]).toEqual(before.turns[1]);
    expect(JSON.parse(generation.mock.calls[0][1].body as string).prompt).not.toContain('Original future remains here.');
    expect(research).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
    generation.mockClear();
    fireEvent.click(pages(1).getByRole('button', { name: 'Previous page for turn 1' }));
    expect(pages(1).getByText('Page 1 / 2 / Active')).toBeInTheDocument();
    fireEvent.click(pages(1).getByRole('button', { name: 'Next page for turn 1' }));
    expect(pages(1).getByText('Page 2 / 2 / Preview only')).toBeInTheDocument();
    expect(await active()).toEqual(saved);
    expect(generation).not.toHaveBeenCalled(); expect(research).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
  });

  it('continues an old alternative as a child ending at that page while the parent future stays reachable', async () => {
    const { original } = await twoTurns();
    const parent = await alternative();
    fireEvent.click(pages(1).getByRole('button', { name: 'Continue from this page' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Turn 2 pages' })).toBeNull());
    await idle();
    const child = await active();
    expect(child.storyId).toBe(parent.storyId); expect(child.branchId).not.toBe(parent.branchId);
    expect(child.parentBranchId).toBe(parent.branchId);
    expect(child.turns).toHaveLength(1);
    expect(child.turns[0].id).toBe(original.turns[0].id);
    expect(child.turns[0].activePageId).toBe(parent.turns[0].pages[1].id);
    expect(child.head).toEqual(parent.turns[0].pages[1].after);
    expect((await repo.loadBranch(parent.source, parent.storyId, parent.branchId))?.branch).toEqual(parent);
    await waitFor(() => expect(research).toHaveBeenCalledTimes(1));
    expect(String(research.mock.calls[0][0])).not.toContain('retract');
    expect(JSON.parse(research.mock.calls[0][1].body as string)).toMatchObject({ branchId: child.branchId });
    fireEvent.change(screen.getByLabelText('Story branch'), { target: { value: parent.branchId } });
    await screen.findByRole('group', { name: 'Turn 2 pages' });
    expect(await active()).toEqual(parent);
    expect(screen.getByText('"Original future remains here."')).toBeInTheDocument();
  });

  it('historical input editing resolves a new duration and preserves the original input/page and future', async () => {
    const { original } = await twoTurns();
    const child = await edit(1, 'input', '*I wait for five minutes.*');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('history edit'));
    expect(generation).toHaveBeenCalledTimes(1);
    expect(child.branchId).not.toBe(original.branchId); expect(child.parentBranchId).toBe(original.branchId);
    expect(child.turns).toHaveLength(1);
    const changed = child.turns[0].pages.find((page) => page.id === child.turns[0].activePageId)!;
    expect(changed.resolution?.elapsedSeconds).toBe(300);
    expect(changed.resolved?.world.elapsedSeconds).toBe(changed.before!.world.elapsedSeconds + 300);
    expect(original.turns[0].pages[0].resolution?.elapsedSeconds).toBe(60);
    expect(child.turns[0].pages[0].player).toBe(original.turns[0].player);
    expect(child.turns[0].pages[0].reply).toBe(original.turns[0].pages[0].reply);
    expect((await repo.loadBranch(original.source, original.storyId, original.branchId))?.branch).toEqual(original);
  });

  it('historical reply-only editing makes no provider call and retains trusted physical resolution', async () => {
    const { original } = await twoTurns();
    const child = await edit(1, 'reply', '*She breaks her leg and travels to the moon.* "Edited local reply."');
    expect(generation).not.toHaveBeenCalled();
    expect(child.parentBranchId).toBe(original.branchId); expect(child.turns).toHaveLength(1);
    const page = child.turns[0].pages.at(-1)!;
    expect(page.resolution).toEqual(original.turns[0].pages[0].resolution);
    expect(page.before).toEqual(original.turns[0].pages[0].before);
    expect(page.resolved).toEqual(original.turns[0].pages[0].resolved);
    expect(page.after?.world).toEqual(original.turns[0].pages[0].after?.world);
    expect(child.turns[0].pages[0]).toMatchObject(original.turns[0].pages[0]);
    expect((await repo.loadBranch(original.source, original.storyId, original.branchId))?.branch).toEqual(original);
  });

  it('preserves latest original pages when selecting an alternative and editing the selected reply', async () => {
    const { original } = await twoTurns();
    const candidate = await alternative(2);
    fireEvent.click(pages(2).getByRole('button', { name: 'Continue from this page' }));
    await waitFor(() => expect(pages(2).getByText('Page 2 / 2 / Active')).toBeInTheDocument());
    await idle();
    const selected = await active();
    expect(selected.branchId).toBe(original.branchId);
    expect(selected.head).toEqual(candidate.turns[1].pages[1].after);
    const edited = await edit(2, 'reply', '*She waves.* "Latest edited reply."');
    expect(edited.branchId).toBe(original.branchId);
    expect(edited.turns[1].pages).toHaveLength(3);
    expect(edited.turns[1].pages.slice(0, 2)).toEqual(selected.turns[1].pages);
    expect(edited.turns[1].pages[2].resolution).toEqual(selected.turns[1].pages[1].resolution);
    expect(generation).toHaveBeenCalledTimes(1);
  });

  it.each(['quota', 'validation', 'cancel'])('leaves every parent page/head/pointer unchanged after alternative %s failure', async (failure) => {
    const { original } = await twoTurns();
    if (failure === 'quota') db.failWrite = { at: 2, name: 'QuotaExceededError' };
    if (failure === 'validation') generation.mockImplementation(async () => response(''));
    let release: ((value: Response) => void) | undefined;
    if (failure === 'cancel') generation.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate alternative for turn 1' }));
    if (failure === 'cancel') {
      await waitFor(() => expect(generation).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      release!(response(alternativeReply));
    }
    await screen.findByRole('alert'); await idle();
    expect(await active()).toEqual(original);
    expect(await repo.listBranches(original.source)).toHaveLength(1);
    expect(pages(1).getByText('Page 1 / 1 / Active')).toBeInTheDocument();
    expect(research).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
  });

  it('reloads the exact story/branch/pages and exports all inactive pages without authorization', async () => {
    const { view } = await twoTurns();
    const saved = await alternative();
    const raw = exportBranch(saved, launch);
    expect(JSON.parse(raw).branch.turns[0].pages).toHaveLength(2);
    expect(raw).not.toMatch(/"(?:launchId|generationGrant|expiresAt)"/);
    expect(importBranchFile(raw, launch)).toEqual(saved);
    view.unmount();
    render(<App />);
    await screen.findByRole('group', { name: 'Turn 2 pages' });
    expect(pages(1).getByText('Page 1 / 2 / Active')).toBeInTheDocument();
    expect(await active()).toEqual(saved);
    generation.mockClear(); research.mockClear();
    fireEvent.click(pages(1).getByRole('button', { name: 'Next page for turn 1' }));
    expect(pages(1).getByText('Page 2 / 2 / Preview only')).toBeInTheDocument();
    expect(await active()).toEqual(saved);
    expect(generation).not.toHaveBeenCalled(); expect(research).not.toHaveBeenCalled();
  });

  it('forks after any verified turn and deletes latest only into a new branch without removing parent history', async () => {
    const { original } = await twoTurns();
    fireEvent.click(screen.getByRole('button', { name: 'Fork after turn 1' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Turn 2 pages' })).toBeNull());
    await idle();
    const fork = await active();
    expect(fork.parentBranchId).toBe(original.branchId);
    expect(fork.turns).toEqual(original.turns.slice(0, 1));
    expect(fork.head).toEqual(original.turns[0].pages[0].after);
    await waitFor(() => expect(research).toHaveBeenCalledTimes(1));
    expect(String(research.mock.calls[0][0])).not.toContain('retract');
    fireEvent.change(screen.getByLabelText('Story branch'), { target: { value: original.branchId } });
    await screen.findByRole('group', { name: 'Turn 2 pages' });
    research.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Turn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete latest' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Turn 2 pages' })).toBeNull());
    await idle();
    const deleted = await active();
    expect(deleted.branchId).not.toBe(original.branchId); expect(deleted.branchId).not.toBe(fork.branchId);
    expect(deleted.parentBranchId).toBe(original.branchId);
    expect(deleted.head).toEqual(original.turns[1].pages[0].before);
    expect(deleted.draft).toBe(original.turns[1].player);
    expect((await repo.loadBranch(original.source, original.storyId, original.branchId))?.branch).toEqual(original);
    expect(await repo.listBranches(original.source)).toHaveLength(3);
    expect(generation).not.toHaveBeenCalled(); expect(research).not.toHaveBeenCalled();
  });

  it('never creates a child or publishes edited prose when its durable pointer write fails', async () => {
    const { original } = await twoTurns();
    db.failWrite = { at: 2, name: 'QuotaExceededError' };
    fireEvent.click(screen.getByRole('button', { name: 'Edit turn 1' }));
    fireEvent.change(screen.getByLabelText('Edited reply'), { target: { value: '*She waves.* "Uncommitted edit."' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm edit' }));
    await screen.findByRole('alert'); await idle();
    expect(await active()).toEqual(original);
    expect(await repo.listBranches(original.source)).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Edit historical turn' })).toBeInTheDocument();
    expect(screen.queryByText('"Uncommitted edit."')).toBeNull();
    expect(generation).not.toHaveBeenCalled(); expect(research).not.toHaveBeenCalled();
  });

  it.each([false, true])('imports a colliding identity only after explicit replacement consent: %s', async (replace) => {
    const { original } = await twoTurns();
    const incoming = { ...original, draft: 'Imported exact identity draft' };
    const raw = exportBranch(incoming, launch);
    vi.mocked(window.confirm).mockImplementation((message) => String(message).includes('Replace') ? replace : true);
    const file = new File([raw], 'same-branch.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => raw });
    fireEvent.change(screen.getByLabelText('Import V4 session'), { target: { files: [file] } });
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Replace')));
    await idle();
    const saved = await active();
    expect(saved.storyId).toBe(original.storyId); expect(saved.branchId).toBe(original.branchId);
    expect(saved.draft).toBe(replace ? incoming.draft : original.draft);
    expect(saved.turns).toEqual(original.turns);
    expect(await repo.listBranches(original.source)).toHaveLength(1);
    expect(generation).not.toHaveBeenCalled(); expect(research).not.toHaveBeenCalled();
  });
});
