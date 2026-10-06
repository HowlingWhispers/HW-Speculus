import { useRef, useState } from 'react';
import type { V4Session } from '../runtime/session';
import type { ProviderAdapter } from '../../runtime/providers/types';
import { captureBranchOperation, createRootBranch, generationBranchTurn, projectBranch, type V4Branch } from '../runtime/branches';
import { loadActiveBranch, loadBranch, listBranches, saveBranch, type BranchSourceIdentity } from '../storage/branches';
import { sameState } from '../runtime/boundaries';

export class BranchImportCollision extends Error {
  constructor(readonly branchId: string) { super(`Saved branch ${branchId} already exists with different content.`); }
}

export function useBranchController(onSession: (session: V4Session) => void) {
  const current = useRef<V4Branch | null>(null);
  const launch = useRef<V4Session['launch'] | null>(null);
  const selectionRevision = useRef<number | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [branches, setBranches] = useState<V4Branch[]>([]);
  const [branch, setBranch] = useState<V4Branch | null>(null);
  const [conflict, setConflict] = useState<V4Branch | null>(null);

  const serialize = <T,>(action: () => Promise<T>): Promise<T> => {
    const result = queue.current.then(action, action);
    queue.current = result.catch(() => undefined);
    return result;
  };
  const publish = (next: V4Branch) => {
    current.current = next;
    setBranch(next);
    setBranches((items) => [...items.filter((item) => item.branchId !== next.branchId), next]);
    onSession(projectBranch(next, launch.current!));
  };
  const persist = async (candidate: V4Branch, existing: V4Branch | null, activate = true, signal?: AbortSignal) => {
    let saved;
    try {
      saved = await saveBranch(candidate, candidate.source as BranchSourceIdentity, {
        expectedRevision: existing?.revision ?? null,
        expectedSelectionRevision: selectionRevision.current,
        activate,
        signal,
      });
    } catch (cause) {
      if (cause && typeof cause === 'object' && 'kind' in cause && cause.kind === 'conflict') setConflict(candidate);
      throw cause;
    }
    selectionRevision.current = saved.selectionRevision;
    publish(saved.branch);
    setConflict(null);
    return saved.branch;
  };
  const initialize = (session: V4Session, recover = true) => serialize(async () => {
    const root = createRootBranch(session);
    const active = await loadActiveBranch();
    selectionRevision.current = active?.selectionRevision ?? null;
    launch.current = session.launch;
    const records = await listBranches(root.source as BranchSourceIdentity);
    setBranches(records.map((record) => record.branch));
    const matching = recover && active && Object.entries(root.source).every(([key, value]) => active.sourceIdentity[key as keyof BranchSourceIdentity] === value);
    if (matching) {
      publish(active.branch);
      return active.branch;
    }
    return persist(root, null);
  });
  const importBranch = (candidate: V4Branch, session: V4Session, replace = false) => serialize(async () => {
    projectBranch(candidate, session.launch);
    const existing = await loadBranch(candidate.source, candidate.storyId, candidate.branchId);
    const different = existing && !sameState(existing.branch, candidate);
    if (different && !replace) throw new BranchImportCollision(candidate.branchId);
    const active = await loadActiveBranch();
    selectionRevision.current = active?.selectionRevision ?? null;
    launch.current = session.launch;
    setBranches((await listBranches(candidate.source)).map((record) => record.branch));
    const imported = different ? { ...candidate, revision: existing.branch.revision + 1 } : candidate;
    return persist(imported, existing?.branch ?? null);
  });
  const update = (transform: (session: V4Session) => V4Session, label: string, source?: { turnId: string; pageId: string }) => {
    const branchId = current.current?.branchId;
    return serialize(async () => {
    if (!current.current || !launch.current) throw new Error('No durable V4 branch is loaded.');
    if (current.current.branchId !== branchId) throw new Error('The selected branch changed before this action could save.');
    const previous = current.current;
    const session = projectBranch(previous, launch.current);
    const candidate = captureBranchOperation(previous, transform(session), label, source);
    return persist(candidate, previous);
    });
  };
  const commit = (candidate: V4Branch, expected: V4Branch, signal?: AbortSignal) => serialize(async () => {
    if (signal?.aborted) throw new Error('Generation cancelled. No durable state changed.');
    if (!current.current || current.current.branchId !== expected.branchId || current.current.revision !== expected.revision) {
      throw new Error('The active branch changed during this operation. The candidate was not committed.');
    }
    return persist(candidate, candidate.branchId === expected.branchId ? expected : null, true, signal);
  });
  const switchTo = (branchId: string) => serialize(async () => {
    const selected = branches.find((item) => item.branchId === branchId);
    if (!selected) throw new Error('Saved branch not found.');
    return persist(selected, selected);
  });
  const generate = async (provider: ProviderAdapter, options: Parameters<typeof generationBranchTurn>[3]) => {
    const branchId = current.current?.branchId;
    await queue.current;
    if (!current.current || !launch.current) throw new Error('No durable V4 branch is loaded.');
    if (current.current.branchId !== branchId) throw new Error('The selected branch changed before generation started.');
    const expected = current.current;
    const candidate = await generationBranchTurn(expected, launch.current, provider, options);
    if (options?.signal?.aborted) throw new Error('Generation cancelled. No durable state changed.');
    const next = await commit(candidate, expected, options?.signal);
    return projectBranch(next, launch.current);
  };
  const preserveConflict = () => serialize(async () => {
    if (!conflict) throw new Error('No conflicting candidate is available.');
    const active = await loadActiveBranch();
    selectionRevision.current = active?.selectionRevision ?? null;
    return persist({
      ...structuredClone(conflict), branchId: crypto.randomUUID(), revision: 0,
      parentBranchId: conflict.branchId, lineage: [...conflict.lineage, conflict.branchId],
      forkTurnId: conflict.frontier?.turnId ?? null, forkPageId: conflict.frontier?.pageId ?? null,
      label: `${conflict.label} (preserved conflict)`, createdAt: Date.now(),
    }, null);
  });
  const settle = async () => {
    await queue.current;
    return current.current && launch.current ? projectBranch(current.current, launch.current) : null;
  };
  return { branch, branches, conflict, initialize, importBranch, update, commit, switchTo, generate, preserveConflict, settle,
    currentBranch: () => current.current };
}
