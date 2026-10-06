// Copied from v4-branch-storage.test.ts: requests precede completion, writes
// are staged, transactions are serialized, and abort rolls back both stores.
class RequestDouble {
  result: unknown;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}
export class IndexedDBDouble {
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
