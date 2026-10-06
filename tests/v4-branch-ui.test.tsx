import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V4App as AppComponent } from '../src/v4/ui/App';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createRootBranch, type V4Branch } from '../src/v4/runtime/branches';
import { createV4Session } from '../src/v4/runtime/session';
import { createBranchRepository } from '../src/v4/storage/branches';
import { saveV4Session } from '../src/v4/storage/session';
import { loadV4Authorization } from '../src/v4/storage/authorization';
import { v2Package } from './v2-fixtures';
import { IndexedDBDouble } from './v4-indexeddb-fixture';

let db: IndexedDBDouble;
let V4App: typeof AppComponent;
beforeEach(async () => {
  // The production repository caches an open database; each test needs a fresh module.
  vi.resetModules();
  sessionStorage.clear(); localStorage.clear(); history.replaceState({}, '', '/v4');
  db = new IndexedDBDouble();
  vi.stubGlobal('indexedDB', db.factory);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  ({ V4App } = await import('../src/v4/ui/App'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function seed(speechEnabled = false) {
  const session = createV4Session(publicV4Package(v2Package()));
  saveV4Session(session);
  const branch = createRootBranch({ ...session, draft: 'Saved root draft', settings: {
    ...session.settings, tags: 'Root influence', stopSequences: ['ROOT STOP'], speechEnabled, speechRate: 1.4,
  } });
  const repo = createBranchRepository({ indexedDB: db.factory });
  await repo.saveBranch(branch, branch.source, { expectedRevision: null, expectedSelectionRevision: null, activate: true });
  return { branch, repo };
}
function speech() {
  const speak = vi.fn();
  vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn(), getVoices: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
  return speak;
}
function mockLaunchResponse(pkg: unknown) {
  return new Response(JSON.stringify({ package: pkg }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function mockGenerateResponse(text = '*She smiles.* "Durable welcome."') {
  return new Response(JSON.stringify({ text, metadata: {
    provider: 'orbis', model: 'mock', durationMs: 1, completionStatus: 'stop',
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('V4 durable branch UI', () => {
  it('identifies an IndexedDB save at the standalone root without restoring authorization', async () => {
    const { branch, repo } = await seed();
    sessionStorage.clear(); localStorage.clear();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const view = render(<V4App />);
    expect(await screen.findByText('Save identified')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your next turn')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect((await repo.loadActiveBranch())?.branch).toEqual(branch);
    view.unmount();
    history.replaceState({}, '', '/v4?launch=durable-recovery-code');
    fetch.mockResolvedValue(mockLaunchResponse(publicV4Package(v2Package())));
    render(<V4App />);
    await screen.findByLabelText('Your next turn');
    await waitFor(() => expect(screen.getByLabelText('Your next turn')).toHaveValue(branch.draft));
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    expect(screen.getByLabelText('Stop sequences (one per line)')).toHaveValue('ROOT STOP');
    expect(loadV4Authorization()?.primaryAsset.id).toBe(branch.source.sourceId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await repo.loadActiveBranch())?.branch).toEqual(branch);
  });

  it('recovers complete saved drafts and settings and switches without bleeding local settings state', async () => {
    const { branch, repo } = await seed();
    const child: V4Branch = { ...branch, branchId: 'saved-child', parentBranchId: branch.branchId,
      lineage: [branch.branchId], label: 'Saved child', draft: 'Saved child draft',
      settings: { ...branch.settings, tags: 'Child influence', stopSequences: ['CHILD STOP'], speechRate: 0.8 },
    };
    await repo.saveBranch(child, child.source, { expectedRevision: null, expectedSelectionRevision: 1, activate: false });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<V4App />);
    await screen.findByLabelText('Your next turn');
    await waitFor(() => expect(screen.getByLabelText('Your next turn')).toHaveValue(branch.draft));
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    expect(screen.getByLabelText('Tags')).toHaveValue('Root influence');
    expect(screen.getByLabelText('Stop sequences (one per line)')).toHaveValue('ROOT STOP');
    fireEvent.change(screen.getByLabelText('Story branch'), { target: { value: child.branchId } });
    await waitFor(() => expect(screen.getByLabelText('Your next turn')).toHaveValue(child.draft));
    expect(screen.getByLabelText('Tags')).toHaveValue('Child influence');
    expect(screen.getByLabelText('Stop sequences (one per line)')).toHaveValue('CHILD STOP');
    expect(screen.getByLabelText('Speech rate')).toHaveValue(0.8);
    expect((await repo.loadActiveBranch())?.branch.settings).toEqual(child.settings);
    fireEvent.change(screen.getByLabelText('Story branch'), { target: { value: branch.branchId } });
    await waitFor(() => expect(screen.getByLabelText('Your next turn')).toHaveValue(branch.draft));
    expect(screen.getByLabelText('Stop sequences (one per line)')).toHaveValue('ROOT STOP');
    expect((await repo.loadActiveBranch())?.branch).toEqual(branch);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the previous saved story available after creating a new simulation', async () => {
    const { branch, repo } = await seed();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<V4App />);
    await screen.findByLabelText('Your next turn');
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    fireEvent.click(screen.getByRole('button', { name: 'New simulation' }));
    await waitFor(() => expect(screen.getByLabelText('Your next turn')).toHaveValue(''));
    const records = await repo.listBranches(branch.source);
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.branch.branchId === branch.branchId)?.branch).toEqual(branch);
    expect((await repo.loadActiveBranch())?.branch.storyId).not.toBe(branch.storyId);
    fireEvent.change(screen.getByLabelText('Story branch'), { target: { value: branch.branchId } });
    await waitFor(() => expect(screen.getByLabelText('Your next turn')).toHaveValue(branch.draft));
  });

  it.each(['quota', 'late abort'])('does not publish or speak a generated candidate after %s', async (failure) => {
    const { branch, repo } = await seed(true);
    const speak = speech();
    vi.stubGlobal('fetch', vi.fn(async () => mockGenerateResponse()));
    render(<V4App />);
    await screen.findByLabelText('Your next turn');
    if (failure === 'quota') db.failWrite = { at: 2, name: 'QuotaExceededError' };
    else db.abortAtCompletion = true;
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Durable welcome.', { exact: false })).toBeNull();
    expect(screen.getByLabelText('Your next turn')).toHaveValue(branch.draft);
    expect((await repo.loadActiveBranch())?.branch).toEqual(branch);
    expect(speak).not.toHaveBeenCalled();
  });

  it('does not publish a stale generation after another tab advances the branch', async () => {
    const { branch, repo } = await seed(true);
    const speak = speech();
    let release!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    render(<V4App />);
    await screen.findByLabelText('Your next turn');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const winner = { ...branch, revision: branch.revision + 1, draft: 'Another tab owns this draft' };
    await repo.saveBranch(winner, winner.source, { expectedRevision: branch.revision, expectedSelectionRevision: 1, activate: true });
    release(mockGenerateResponse());
    await screen.findByText('Another tab changed this saved branch. Nothing was overwritten.');
    expect(screen.queryByText('Durable welcome.', { exact: false })).toBeNull();
    expect(screen.getByLabelText('Your next turn')).toHaveValue(branch.draft);
    expect((await repo.loadActiveBranch())?.branch).toEqual(winner);
    expect(speak).not.toHaveBeenCalled();
  });

  it.each([false, true])('autoplays only after durable completion when opted in: %s', async (enabled) => {
    const { repo } = await seed(enabled);
    const speak = speech();
    let completedWhenSpoken = false;
    speak.mockImplementation(() => {
      const records = [...db.stores.get('branches')!.values()] as { branch: V4Branch }[];
      completedWhenSpoken = records.some((record) => record.branch.turns.length === 1);
    });
    vi.stubGlobal('fetch', vi.fn(async () => mockGenerateResponse()));
    render(<V4App />);
    await screen.findByLabelText('Your next turn');
    expect(speak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Durable welcome.', { exact: false });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    expect((await repo.loadActiveBranch())?.branch.turns).toHaveLength(1);
    expect(speak).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(completedWhenSpoken).toBe(enabled);
  });
});
