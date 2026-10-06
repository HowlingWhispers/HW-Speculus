import { z } from 'zod';
import { branchSchema, branchSourceSchema, type V4Branch, type V4BranchSource } from '../runtime/branches';

export const V4_BRANCH_DATABASE = 'speculus.branches.v4';
const BRANCHES = 'branches';
const POINTERS = 'active';
const ACTIVE = 'selection';
const sourceIdentitySchema = branchSourceSchema;
export type BranchSourceIdentity = V4BranchSource;
export interface BranchSnapshot { branch: V4Branch; sourceIdentity: BranchSourceIdentity }
export interface ActiveBranchSnapshot extends BranchSnapshot { selectionRevision: number }
export interface SaveBranchOptions {
  expectedRevision: number | null;
  expectedSelectionRevision: number | null;
  activate: boolean;
  signal?: AbortSignal;
}
export interface SavedBranchSnapshot extends BranchSnapshot { selectionRevision: number | null }
export interface BranchRepository {
  listBranches(identity: BranchSourceIdentity): Promise<BranchSnapshot[]>;
  loadBranch(identity: BranchSourceIdentity, storyId: string, branchId: string): Promise<BranchSnapshot | null>;
  loadActiveBranch(identity?: BranchSourceIdentity): Promise<ActiveBranchSnapshot | null>;
  saveBranch(branch: V4Branch, identity: BranchSourceIdentity, options: SaveBranchOptions): Promise<SavedBranchSnapshot>;
}

export class BranchStorageError extends Error {
  constructor(readonly kind: 'quota' | 'failure' | 'validation', message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'BranchStorageError';
  }
}
export class BranchStorageConflictError extends Error {
  readonly kind = 'conflict';
  constructor(readonly reason: 'branch' | 'selection', readonly expectedRevision: number | null, readonly actualRevision: number | null) {
    super(`V4 ${reason} revision changed in storage. Reload or preserve your changes as a new branch.`);
    this.name = 'BranchStorageConflictError';
  }
}

const recordSchema = z.object({ branch: branchSchema, sourceIdentity: sourceIdentitySchema });
const pointerSchema = z.object({ key: z.string(), sourceIdentity: sourceIdentitySchema, revision: z.number().int().positive() });
type Pointer = z.infer<typeof pointerSchema>;

function identityKey(identity: BranchSourceIdentity): string {
  return JSON.stringify([identity.sourceType, identity.sourceId, identity.sourceRevision, identity.personaId, identity.subjectId]);
}
export function branchStorageKey(identity: BranchSourceIdentity, storyId: string, branchId: string): string {
  return JSON.stringify([identity.sourceType, identity.sourceId, identity.sourceRevision, identity.personaId, identity.subjectId, storyId, branchId]);
}
function storageError(cause: unknown): BranchStorageError | BranchStorageConflictError {
  if (cause instanceof BranchStorageError || cause instanceof BranchStorageConflictError) return cause;
  const quota = cause && typeof cause === 'object' && 'name' in cause && cause.name === 'QuotaExceededError';
  return new BranchStorageError(quota ? 'quota' : 'failure', quota ? 'V4 branch storage quota exceeded. Prior saved state was preserved.' : 'V4 branch storage failed. Prior saved state was preserved.', cause);
}
function validate<T>(read: () => T): T {
  try { return read(); } catch (cause) { throw new BranchStorageError('validation', 'Invalid V4 branch storage data.', cause); }
}
function parseSnapshot(value: unknown, key?: string): BranchSnapshot {
  return validate(() => {
    const snapshot = recordSchema.parse(value);
    if (identityKey(snapshot.sourceIdentity) !== identityKey(snapshot.branch.source)
      || (key !== undefined && branchStorageKey(snapshot.sourceIdentity, snapshot.branch.storyId, snapshot.branch.branchId) !== key)) {
      throw new Error('Branch source/key mismatch.');
    }
    return snapshot;
  });
}

export function createBranchRepository(options: { indexedDB?: IDBFactory; databaseName?: string } = {}): BranchRepository {
  let database: Promise<IDBDatabase> | undefined;
  let saves: Promise<unknown> = Promise.resolve();
  function open(): Promise<IDBDatabase> {
    if (database) return database;
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new BranchStorageError('failure', 'IndexedDB is unavailable. No fallback save was written.')); return; }
      const request = factory.open(options.databaseName ?? V4_BRANCH_DATABASE, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BRANCHES)) db.createObjectStore(BRANCHES);
        if (!db.objectStoreNames.contains(POINTERS)) db.createObjectStore(POINTERS);
      };
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => {
        blocked = true;
        reject(new BranchStorageError('failure', 'V4 branch database upgrade is blocked by another tab.'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
    }).catch((cause: unknown) => { database = undefined; throw storageError(cause); });
    return database;
  }

  async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction, result: (value: T) => void, fail: (cause: unknown) => void) => void, signal?: AbortSignal): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction([BRANCHES, POINTERS], mode); } catch (cause) { reject(storageError(cause)); return; }
      let value: T;
      let failure: unknown;
      const cancel = () => {
        try {
          tx.abort();
          failure = new DOMException('Branch commit cancelled.', 'AbortError');
        } catch {
          // A finished transaction is already committed; cancellation is too late.
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      const fail = (cause: unknown) => {
        failure = cause;
        try { tx.abort(); } catch { reject(storageError(cause)); }
      };
      tx.oncomplete = () => { cleanup(); resolve(value); };
      tx.onabort = () => { cleanup(); reject(storageError(failure ?? tx.error)); };
      tx.onerror = (event) => {
        const request = event.target as IDBRequest | null;
        failure ??= request?.error ?? tx.error;
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      try { work(tx, (next) => { value = next; }, fail); } catch (cause) { fail(cause); }
    });
  }

  const repository: BranchRepository = {
    async listBranches(identity) {
      const source = validate(() => sourceIdentitySchema.parse(identity));
      return transaction('readonly', (tx, result, fail) => {
        const request = tx.objectStore(BRANCHES).openCursor();
        const branches: BranchSnapshot[] = [];
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor) { result(branches); return; }
            const snapshot = parseSnapshot(cursor.value, String(cursor.key));
            if (identityKey(snapshot.sourceIdentity) === identityKey(source)) branches.push(snapshot);
            cursor.continue();
          } catch (cause) { fail(cause); }
        };
      });
    },
    async loadBranch(identity, storyId, branchId) {
      const source = validate(() => sourceIdentitySchema.parse(identity));
      const key = branchStorageKey(source, storyId, branchId);
      return transaction('readonly', (tx, result, fail) => {
        const request = tx.objectStore(BRANCHES).get(key);
        request.onsuccess = () => {
          try { result(request.result === undefined ? null : parseSnapshot(request.result, key)); } catch (cause) { fail(cause); }
        };
      });
    },
    async loadActiveBranch(identity) {
      const source = identity === undefined ? undefined : validate(() => sourceIdentitySchema.parse(identity));
      return transaction('readonly', (tx, result, fail) => {
        const request = tx.objectStore(POINTERS).get(ACTIVE);
        request.onsuccess = () => {
          try {
            if (request.result === undefined) { result(null); return; }
            const pointer = validate(() => pointerSchema.parse(request.result));
            if (source && identityKey(pointer.sourceIdentity) !== identityKey(source)) { result(null); return; }
            const branchRequest = tx.objectStore(BRANCHES).get(pointer.key);
            branchRequest.onsuccess = () => {
              try {
                const snapshot = parseSnapshot(branchRequest.result, pointer.key);
                if (identityKey(snapshot.sourceIdentity) !== identityKey(pointer.sourceIdentity)) throw new BranchStorageError('validation', 'Active V4 source mismatch.');
                result({ ...snapshot, selectionRevision: pointer.revision });
              } catch (cause) { fail(cause); }
            };
          } catch (cause) { fail(cause); }
        };
      });
    },
    saveBranch(branch, identity, saveOptions) {
      // Capture validated copies before queuing; callers cannot mutate an in-flight candidate.
      let snapshot: BranchSnapshot;
      let expected: SaveBranchOptions;
      try {
        snapshot = parseSnapshot({ branch, sourceIdentity: identity });
        expected = validate(() => z.object({ expectedRevision: z.number().int().nonnegative().nullable(), expectedSelectionRevision: z.number().int().positive().nullable(), activate: z.boolean() }).parse(saveOptions));
      } catch (cause) { return Promise.reject(cause); }
      const signal = saveOptions.signal;
      const save = saves.then(() => transaction<SavedBranchSnapshot>('readwrite', (tx, result, fail) => {
        const key = branchStorageKey(snapshot.sourceIdentity, snapshot.branch.storyId, snapshot.branch.branchId);
        const branchStore = tx.objectStore(BRANCHES);
        const pointerStore = tx.objectStore(POINTERS);
        const branchRequest = branchStore.get(key);
        const pointerRequest = pointerStore.get(ACTIVE);
        let branchReady = false;
        let pointerReady = false;
        function commit() {
          if (!branchReady || !pointerReady) return;
          try {
            const previous = branchRequest.result === undefined ? null : parseSnapshot(branchRequest.result, key);
            const pointer: Pointer | null = pointerRequest.result === undefined ? null : validate(() => pointerSchema.parse(pointerRequest.result));
            const actualRevision = previous?.branch.revision ?? null;
            const actualSelection = pointer?.revision ?? null;
            if (actualRevision !== expected.expectedRevision) throw new BranchStorageConflictError('branch', expected.expectedRevision, actualRevision);
            if (actualSelection !== expected.expectedSelectionRevision) throw new BranchStorageConflictError('selection', expected.expectedSelectionRevision, actualSelection);
            if (previous && snapshot.branch.revision !== previous.branch.revision + 1
              && !(snapshot.branch.revision === previous.branch.revision && JSON.stringify(snapshot) === JSON.stringify(previous))) {
              throw new BranchStorageError('validation', 'V4 branch updates must advance revision exactly once.');
            }
            const selectionRevision = expected.activate ? (actualSelection ?? 0) + 1 : actualSelection;
            branchStore.put(snapshot, key);
            if (expected.activate) pointerStore.put({ key, sourceIdentity: snapshot.sourceIdentity, revision: selectionRevision }, ACTIVE);
            result({ ...snapshot, selectionRevision });
          } catch (cause) { fail(cause); }
        }
        branchRequest.onsuccess = () => { branchReady = true; commit(); };
        pointerRequest.onsuccess = () => { pointerReady = true; commit(); };
      }, signal));
      saves = save.catch(() => undefined);
      return save;
    },
  };
  return repository;
}

const defaultRepository = createBranchRepository();
export const listBranches: BranchRepository['listBranches'] = (identity) => defaultRepository.listBranches(identity);
export const loadBranch: BranchRepository['loadBranch'] = (identity, storyId, branchId) => defaultRepository.loadBranch(identity, storyId, branchId);
export const loadActiveBranch: BranchRepository['loadActiveBranch'] = (identity) => defaultRepository.loadActiveBranch(identity);
export const saveBranch: BranchRepository['saveBranch'] = (branch, identity, options) => defaultRepository.saveBranch(branch, identity, options);
