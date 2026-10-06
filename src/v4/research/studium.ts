import type { V4ClientPackage } from '../contracts/launch';
import { projectBranch, type V4Branch } from '../runtime/branches';

const pending = new Map<string, Promise<void>>();

function enqueue(branch: V4Branch, turnId: string, path: string, body: unknown): Promise<void> {
  const key = JSON.stringify([branch.storyId, branch.branchId, turnId]);
  const payload = JSON.stringify(body);
  // Submission and retraction share one queue; a failed handoff must not block recovery.
  const operation = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: payload,
    });
    if (!response.ok && !(path.endsWith('/retract') && response.status === 404)) {
      throw new Error(`Studium research handoff failed with HTTP ${response.status}.`);
    }
  });
  pending.set(key, operation);
  const cleanup = () => { if (pending.get(key) === operation) pending.delete(key); };
  void operation.then(cleanup, cleanup);
  return operation;
}

export async function submitBranchTurnToStudium(branch: V4Branch, launch: V4ClientPackage,
  turnId = branch.frontier?.turnId): Promise<void> {
  if (!turnId) return;
  const session = projectBranch(branch, launch);
  const turn = branch.turns.find((value) => value.id === turnId);
  if (!turn) throw new Error('Research turn is not a branch member.');
  const page = turn.pages.find((value) => value.id === turn.activePageId)!;
  return enqueue(branch, turnId, '/api/v4/research', {
    launchId: launch.launchId, storyId: branch.storyId, branchId: branch.branchId, turnId, pageId: page.id,
    occurredAt: page.createdAt, player: turn.player, reply: page.reply, worldRevision: page.worldRevision,
    locationId: page.after?.world.locationId ?? session.world.locationId, engine: 'v4',
  });
}

export async function retractBranchTurnFromStudium(branch: V4Branch, launch: V4ClientPackage,
  turnId: string, pageId?: string): Promise<void> {
  projectBranch(branch, launch);
  const selectedPageId = pageId ?? branch.turns.find((value) => value.id === turnId)?.activePageId;
  if (!selectedPageId) throw new Error('Research retraction requires the removed page identity.');
  return enqueue(branch, turnId, '/api/v4/research/retract', {
    launchId: launch.launchId, storyId: branch.storyId, branchId: branch.branchId, turnId, pageId: selectedPageId, engine: 'v4',
  });
}

export async function submitLatestTurnToStudium(branch: V4Branch, launch: V4ClientPackage): Promise<void> {
  return submitBranchTurnToStudium(branch, launch);
}

export async function retractLatestTurnFromStudium(branch: V4Branch, launch: V4ClientPackage): Promise<void> {
  if (!branch.frontier) return;
  return retractBranchTurnFromStudium(branch, launch, branch.frontier.turnId, branch.frontier.pageId);
}
