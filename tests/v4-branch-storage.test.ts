import { describe, expect, it } from 'vitest';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createRootBranch, generationBranchTurn, type V4Branch } from '../src/v4/runtime/branches';
import { createV4Session } from '../src/v4/runtime/session';
import { MockProvider } from '../src/runtime/providers/mock';
import { branchStorageKey, BranchStorageConflictError, createBranchRepository, type BranchSourceIdentity } from '../src/v4/storage/branches';
import { v2Package } from './v2-fixtures';

// Native-IDB-shaped double: requests succeed before completion; writes are staged,
// transactions are serialized, and abort rolls back both object stores.
class RequestDouble {
  result: unknown;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}
class IndexedDBDouble {
  stores = new Map<string, Map<string, unknown>>();
  failWrite: { at: number; name: string } | null = null;
  abortAtCompletion = false;
  completed = 0;
  active = false;
  queue: TransactionDouble[] = [];
  readonly factory = { open: () => {
    const request = new RequestDouble();
    setTimeout(() => {
      request.result = {
        objectStoreNames: { contains: (name: string) => this.stores.has(name) },
        createObjectStore: (name: string) => this.stores.set(name, new Map()),
        transaction: (_names: string[], mode: IDBTransactionMode) => {
          const tx = new TransactionDouble(this, mode);
          this.queue.push(tx);
          this.start();
          return tx;
        },
        close: () => undefined,
      };
      request.onupgradeneeded?.();
      request.onsuccess?.();
    }, 0);
    return request;
  } } as unknown as IDBFactory;
  start() {
    if (this.active || !this.queue.length) return;
    this.active = true;
    setTimeout(() => this.queue[0].begin(), 0);
  }
  finish() {
    this.queue.shift();
    this.active = false;
    this.start();
  }
}
class TransactionDouble {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: ((event: { target: RequestDouble }) => void) | null = null;
  error: DOMException | null = null;
  private staged = new Map<string, Map<string, unknown>>();
  private jobs: (() => void)[] = [];
  private begun = false;
  private ended = false;
  private pending = 0;
  private writes = 0;
  constructor(private owner: IndexedDBDouble, private mode: IDBTransactionMode) {}
  begin() {
    this.begun = true;
    this.staged = new Map([...this.owner.stores].map(([name, values]) => [name, new Map(values)]));
    this.jobs.splice(0).forEach((job) => job());
    this.completeWhenIdle();
  }
  private request(operation: () => unknown, write = false) {
    const request = new RequestDouble();
    this.pending++;
    const job = () => setTimeout(() => {
      if (this.ended) return;
      try {
        if (write && this.owner.failWrite?.at === ++this.writes) {
          const failure = this.owner.failWrite;
          this.owner.failWrite = null;
          throw new DOMException('Injected write failure', failure.name);
        }
        request.result = operation();
        request.onsuccess?.();
        this.pending--;
        this.completeWhenIdle();
      } catch (cause) {
        request.error = cause as DOMException;
        this.error = request.error;
        request.onerror?.();
        this.onerror?.({ target: request });
        this.abort();
      }
    }, 0);
    if (this.begun) job(); else this.jobs.push(job);
    return request;
  }
  objectStore(name: string) {
    return {
      get: (key: string) => this.request(() => structuredClone(this.staged.get(name)?.get(key))),
      put: (value: unknown, key: string) => this.request(() => {
        this.staged.get(name)!.set(key, structuredClone(value));
        return key;
      }, true),
      openCursor: () => {
        let entries: [string, unknown][] | undefined;
        let index = 0;
        const request = new RequestDouble();
        const next = () => {
          const pending = this.request(() => {
            entries ??= [...this.staged.get(name)!];
            const entry = entries[index++];
            return entry ? { key: entry[0], value: structuredClone(entry[1]), continue: next } : null;
          });
          pending.onsuccess = () => { request.result = pending.result; request.onsuccess?.(); };
        };
        next();
        return request;
      },
    };
  }
  private completeWhenIdle() {
    setTimeout(() => {
      if (this.ended || this.pending) return;
      if (this.owner.abortAtCompletion && this.mode === 'readwrite') {
        this.owner.abortAtCompletion = false;
        this.error = new DOMException('Injected late abort', 'AbortError');
        this.abort();
        return;
      }
      this.ended = true;
      if (this.mode === 'readwrite') this.owner.stores = this.staged;
      this.owner.completed++;
      this.oncomplete?.();
      this.owner.finish();
    }, 0);
  }
  abort() {
    if (this.ended) return;
    this.ended = true;
    setTimeout(() => { this.onabort?.(); this.owner.finish(); }, 0);
  }
}

function setup() {
  const db = new IndexedDBDouble();
  const repo = createBranchRepository({ indexedDB: db.factory });
  const branch = createRootBranch(createV4Session(publicV4Package(v2Package())));
  return { db, repo, branch, identity: branch.source };
}
const insert = { expectedRevision: null, expectedSelectionRevision: null, activate: true };
function edit(branch: V4Branch, draft = 'Changed draft'): V4Branch {
  return { ...branch, revision: branch.revision + 1, draft };
}

describe('V4 native IndexedDB branch repository', () => {
  it('aborts a cancelled candidate without changing its durable branch or pointer', async () => {
    const { repo, branch, identity } = setup();
    await repo.saveBranch(branch, identity, insert);
    const controller = new AbortController();
    controller.abort();
    await expect(repo.saveBranch(edit(branch), identity, { expectedRevision: 0, expectedSelectionRevision: 1, activate: true, signal: controller.signal })).rejects.toThrow();
    expect((await repo.loadActiveBranch())?.branch).toEqual(branch);
    expect((await repo.loadActiveBranch())?.selectionRevision).toBe(1);
  });
  it('atomically persists a complete branch and pointer and resolves only after completion', async () => {
    const { db, repo, branch, identity } = setup();
    const saved = await repo.saveBranch(branch, identity, insert);
    expect(db.completed).toBe(1);
    expect(saved.selectionRevision).toBe(1);
    const reloaded = createBranchRepository({ indexedDB: db.factory });
    expect(await reloaded.loadActiveBranch(identity)).toEqual({ branch, sourceIdentity: identity, selectionRevision: 1 });
    expect(await reloaded.loadBranch(identity, branch.storyId, branch.branchId)).toEqual({ branch, sourceIdentity: identity });
  });

  it('preserves prior stories and inactive branches on new-story creation', async () => {
    const { repo, branch, identity } = setup();
    await repo.saveBranch(branch, identity, insert);
    const next = { ...branch, storyId: 'new-story', branchId: 'new-root' };
    await repo.saveBranch(next, identity, { ...insert, expectedSelectionRevision: 1 });
    expect((await repo.listBranches(identity)).map((record) => record.branch.storyId)).toEqual([branch.storyId, 'new-story']);
    expect((await repo.loadActiveBranch())?.branch).toEqual(next);
  });

  it('round-trips generated pages, trusted resolution and complete checkpoints without losing head state', async () => {
    const { repo, branch, identity } = setup();
    const generated = await generationBranchTurn({ ...branch, draft: '*I look around.*' }, publicV4Package(v2Package()), new MockProvider());
    await repo.saveBranch(generated, identity, insert);
    const loaded = (await repo.loadActiveBranch())!.branch;
    expect(loaded).toEqual(generated);
    expect(loaded.turns[0].pages[0]).toMatchObject({ before: {}, resolved: {}, after: {}, resolution: {} });
    expect(loaded.head).toEqual(generated.head);
  });

  it.each(['QuotaExceededError', 'UnknownError'])('rolls back both stores when pointer put fails: %s', async (name) => {
    const { db, repo, branch, identity } = setup();
    await repo.saveBranch(branch, identity, insert);
    db.failWrite = { at: 2, name };
    await expect(repo.saveBranch(edit(branch), identity, { expectedRevision: branch.revision, expectedSelectionRevision: 1, activate: true }))
      .rejects.toMatchObject({ kind: name === 'QuotaExceededError' ? 'quota' : 'failure' });
    expect(await repo.loadActiveBranch()).toEqual({ branch, sourceIdentity: identity, selectionRevision: 1 });
    expect((await repo.loadBranch(identity, branch.storyId, branch.branchId))?.branch).toEqual(branch);
  });

  it('rejects a late transaction abort even after both put requests succeeded', async () => {
    const { db, repo, branch, identity } = setup();
    await repo.saveBranch(branch, identity, insert);
    db.abortAtCompletion = true;
    await expect(repo.saveBranch(edit(branch), identity, { expectedRevision: branch.revision, expectedSelectionRevision: 1, activate: true }))
      .rejects.toMatchObject({ kind: 'failure' });
    expect((await repo.loadActiveBranch())?.branch).toEqual(branch);
  });

  it('does not create a dangling pointer or branch after an initial quota failure', async () => {
    const { db, repo, branch, identity } = setup();
    db.failWrite = { at: 1, name: 'QuotaExceededError' };
    await expect(repo.saveBranch(branch, identity, insert)).rejects.toMatchObject({ kind: 'quota' });
    expect(await repo.loadActiveBranch()).toBeNull();
    expect(await repo.listBranches(identity)).toEqual([]);
    await repo.saveBranch(branch, identity, insert);
    expect((await repo.loadActiveBranch())?.selectionRevision).toBe(1);
  });

  it('never overwrites an existing branch with insert-only expectedRevision null', async () => {
    const { repo, branch, identity } = setup();
    await repo.saveBranch(branch, identity, insert);
    await expect(repo.saveBranch(edit(branch), identity, { ...insert, expectedSelectionRevision: 1 }))
      .rejects.toMatchObject({ kind: 'conflict', reason: 'branch', actualRevision: branch.revision });
    expect((await repo.loadActiveBranch())?.branch).toEqual(branch);
  });

  it('detects branch revision conflicts across repositories/tabs without overwriting', async () => {
    const { db, repo, branch, identity } = setup();
    const secondTab = createBranchRepository({ indexedDB: db.factory });
    await repo.saveBranch(branch, identity, insert);
    const expected = { expectedRevision: branch.revision, expectedSelectionRevision: 1, activate: false };
    await repo.saveBranch(edit(branch, 'First tab'), identity, expected);
    await expect(secondTab.saveBranch(edit(branch, 'Second tab'), identity, expected)).rejects.toBeInstanceOf(BranchStorageConflictError);
    expect((await repo.loadActiveBranch())?.branch.draft).toBe('First tab');
  });

  it('guards a stale save after another tab switches to a different story', async () => {
    const { db, repo, branch, identity } = setup();
    const secondTab = createBranchRepository({ indexedDB: db.factory });
    await repo.saveBranch(branch, identity, insert);
    await secondTab.saveBranch({ ...branch, storyId: 'another-story', branchId: 'another-root' }, identity, { ...insert, expectedSelectionRevision: 1 });
    await expect(repo.saveBranch(edit(branch), identity, { expectedRevision: branch.revision, expectedSelectionRevision: 1, activate: false }))
      .rejects.toMatchObject({ kind: 'conflict', reason: 'selection', actualRevision: 2 });
    expect((await repo.loadBranch(identity, branch.storyId, branch.branchId))?.branch).toEqual(branch);
    expect((await repo.loadActiveBranch())?.branch.storyId).toBe('another-story');
  });

  it('serializes queued saves and recovers its queue after failure', async () => {
    const { repo, branch, identity } = setup();
    const first = repo.saveBranch(branch, identity, insert);
    const rejected = repo.saveBranch(edit(branch), identity, { ...insert, expectedSelectionRevision: 1 });
    const rejectedAssertion = expect(rejected).rejects.toMatchObject({ kind: 'conflict' });
    const last = repo.saveBranch(edit(branch), identity, { expectedRevision: branch.revision, expectedSelectionRevision: 1, activate: true });
    await first;
    await rejectedAssertion;
    expect((await last).selectionRevision).toBe(2);
    expect((await repo.loadActiveBranch())?.branch).toEqual(edit(branch));
  });

  it('supports switching an unchanged branch, but rejects changed content without revision advance', async () => {
    const { repo, branch, identity } = setup();
    await repo.saveBranch(branch, identity, insert);
    await expect(repo.saveBranch({ ...branch, draft: 'Silent overwrite' }, identity, { expectedRevision: branch.revision, expectedSelectionRevision: 1, activate: true }))
      .rejects.toMatchObject({ kind: 'validation' });
    const selected = await repo.saveBranch(branch, identity, { expectedRevision: branch.revision, expectedSelectionRevision: 1, activate: true });
    expect(selected.selectionRevision).toBe(2);
  });

  it('uses full collision-free type/id/revision/persona/subject/story/branch keys', async () => {
    const { repo, branch, identity } = setup();
    const variants: BranchSourceIdentity[] = [
      identity, { ...identity, sourceType: 'different' }, { ...identity, sourceId: `${identity.sourceId}:tail` },
      { ...identity, sourceRevision: `${identity.sourceRevision}:tail` }, { ...identity, personaId: `${identity.personaId}:tail` },
      { ...identity, subjectId: 'different' }, { ...identity, sourceId: 'a:b', personaId: 'c' },
      { ...identity, sourceId: 'a', personaId: 'b:c' }, { ...identity, sourceId: 'x'.repeat(500) + '1' },
      { ...identity, sourceId: 'x'.repeat(500) + '2' },
    ];
    const keys = variants.map((source) => branchStorageKey(source, branch.storyId, branch.branchId));
    keys.push(branchStorageKey(identity, branch.storyId + ':tail', branch.branchId), branchStorageKey(identity, branch.storyId, branch.branchId + ':tail'));
    expect(new Set(keys).size).toBe(keys.length);
    for (const source of variants) {
      await repo.saveBranch({ ...branch, source }, source, { ...insert, activate: false });
      expect(await repo.listBranches(source)).toHaveLength(1);
    }
  });

  it('isolates active identity matching and permits unauthenticated metadata-only recovery', async () => {
    const { repo, branch, identity } = setup();
    await repo.saveBranch(branch, identity, insert);
    expect(await repo.loadActiveBranch({ ...identity, personaId: 'another-persona' })).toBeNull();
    expect(await repo.loadActiveBranch({ ...identity, subjectId: 'another-subject' })).toBeNull();
    expect(await repo.loadActiveBranch()).not.toBeNull();
  });

  it('validates source consistency and branch schema before writing', async () => {
    const { db, repo, branch, identity } = setup();
    await expect(repo.saveBranch(branch, { ...identity, sourceId: 'wrong' }, insert)).rejects.toMatchObject({ kind: 'validation' });
    await expect(repo.saveBranch({ ...branch, revision: -1 }, identity, insert)).rejects.toMatchObject({ kind: 'validation' });
    expect(db.stores.size).toBe(0);
  });

  it('strips launch authorization and unknown metadata and captures the candidate before enqueueing', async () => {
    const { db, repo, branch, identity } = setup();
    const candidate = { ...branch, launch: v2Package(), launchId: 'secret', generationGrant: 'secret' };
    const promise = repo.saveBranch(candidate, { ...identity, launchId: 'secret' } as BranchSourceIdentity, insert);
    candidate.draft = 'Mutated after enqueue';
    await promise;
    expect((await repo.loadActiveBranch())?.branch.draft).toBe(branch.draft);
    const serialized = JSON.stringify([...db.stores.get('branches')!.values()]);
    expect(serialized).not.toMatch(/"(?:launch|launchId|generationGrant|expiresAt)"/);
    expect(serialized).not.toContain('secret');
  });

  it('does not fall back to localStorage when IndexedDB is unavailable', async () => {
    const { branch, identity } = setup();
    const repo = createBranchRepository({ indexedDB: undefined });
    await expect(repo.saveBranch(branch, identity, insert)).rejects.toMatchObject({ kind: 'failure' });
  });
});
