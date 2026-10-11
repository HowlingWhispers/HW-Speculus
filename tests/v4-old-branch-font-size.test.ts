import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/runtime/providers/mock';
import { publicV4Package } from '../src/v4/contracts/launch';
import { branchSchema, captureBranchOperation, createRootBranch, generationBranchTurn, projectBranch, type V4Branch } from '../src/v4/runtime/branches';
import { createV4Session, operateWorld } from '../src/v4/runtime/session';
import { branchStorageKey, createBranchRepository } from '../src/v4/storage/branches';
import { exportBranch, importBranchFile, inspectBranchFile } from '../src/v4/storage/branch-transfer';
import { IndexedDBDouble } from './v4-indexeddb-fixture';
import { v2Package } from './v2-fixtures';

const launch = () => publicV4Package(v2Package());

async function generatedBranch() {
  const pkg = launch();
  const root = createRootBranch(createV4Session(pkg));
  const operated = captureBranchOperation(root, operateWorld(projectBranch(root, pkg), {
    type: 'advance-clock', seconds: 60,
  }), 'Saved clock advance');
  const first = await generationBranchTurn({ ...operated, draft: '*I look around.*' }, pkg, new MockProvider());
  const second = await generationBranchTurn({ ...first, draft: '*I wait for one minute.*' }, pkg, new MockProvider());
  return { ...second, draft: 'Preserved old draft', settings: { ...second.settings, tags: 'Saved influence', stopSequences: ['SAVED STOP'] } };
}

function oldBranch(branch: V4Branch): V4Branch {
  const raw: V4Branch = JSON.parse(JSON.stringify(branch));
  Reflect.deleteProperty(raw.settings, 'generatedTextFontSize');
  return raw;
}

function seedRaw(branch: V4Branch) {
  const db = new IndexedDBDouble();
  const key = branchStorageKey(branch.source, branch.storyId, branch.branchId);
  // Seed the historical wire record directly: saveBranch would normalize it first.
  db.stores.set('branches', new Map([[key, { branch, sourceIdentity: branch.source }]]));
  db.stores.set('active', new Map([['selection', { key, sourceIdentity: branch.source, revision: 7 }]]));
  return { db, key, repo: createBranchRepository({ indexedDB: db.factory }) };
}

async function expectRepositoryRejection(raw: V4Branch) {
  const { repo } = seedRaw(raw);
  const error = { kind: 'validation', message: 'Invalid V4 branch storage data.' };
  await expect(repo.loadActiveBranch(raw.source)).rejects.toMatchObject(error);
  await expect(repo.listBranches(raw.source)).rejects.toMatchObject(error);
  await expect(repo.loadBranch(raw.source, raw.storyId, raw.branchId)).rejects.toMatchObject(error);
}

describe('V4 branches saved before generatedTextFontSize', () => {
  it('defaults only the new preference on every repository read and can durably save an edit', async () => {
    const branch = await generatedBranch();
    const raw = oldBranch(branch);
    const { db, key, repo } = seedRaw(raw);
    const snapshot = { branch, sourceIdentity: branch.source };
    expect(branch.turns).toHaveLength(2);
    expect(branch.operations).toHaveLength(1);
    expect(branch.settings.generatedTextFontSize).toBe(20);
    expect(Object.hasOwn(raw.settings, 'generatedTextFontSize')).toBe(false);

    const active = await repo.loadActiveBranch(branch.source);
    expect(active).toEqual({ ...snapshot, selectionRevision: 7 });
    expect(await repo.loadActiveBranch()).toEqual(active);
    expect(await repo.listBranches(branch.source)).toEqual([snapshot]);
    expect(await repo.loadBranch(branch.source, branch.storyId, branch.branchId)).toEqual(snapshot);
    // Reading must not rewrite history, IDs, world state, branch revision or pointer.
    expect(db.stores.get('branches')!.get(key)).toEqual({ branch: raw, sourceIdentity: branch.source });
    expect(Object.hasOwn(raw.settings, 'generatedTextFontSize')).toBe(false);

    const edited = { ...active!.branch, draft: 'Edited restored draft', revision: branch.revision + 1 };
    expect(await repo.saveBranch(edited, branch.source, {
      expectedRevision: branch.revision, expectedSelectionRevision: 7, activate: true,
    })).toEqual({ branch: edited, sourceIdentity: branch.source, selectionRevision: 8 });
    const reopened = createBranchRepository({ indexedDB: db.factory });
    expect(await reopened.loadActiveBranch(branch.source)).toEqual({ branch: edited, sourceIdentity: branch.source, selectionRevision: 8 });
    expect(db.stores.get('branches')!.get(key)).toEqual({ branch: edited, sourceIdentity: branch.source });
  });

  it('imports a raw canonical branch file without the new preference and preserves all authority', async () => {
    const branch = await generatedBranch();
    const transfer = JSON.parse(exportBranch(branch, launch()));
    delete transfer.branch.settings.generatedTextFontSize;
    const raw = JSON.stringify(transfer);
    expect(inspectBranchFile(raw)).toEqual(transfer.source);
    expect(importBranchFile(raw, launch())).toEqual(branch);
    expect(importBranchFile(exportBranch(importBranchFile(raw, launch())), launch())).toEqual(branch);
  });

  it.each(['initial', 'head', 'before', 'resolved', 'after', 'operation-before', 'operation-after'] as const)(
    'still rejects missing authoritative fields in %s checkpoints of an old branch', async (location) => {
      const branch = await generatedBranch();
      for (const field of ['world', 'relationships', 'stateProposals', 'events', 'nextTurn']) {
        const raw = oldBranch(branch);
        const checkpoint = location === 'initial' || location === 'head' ? raw[location]
          : location === 'operation-before' ? raw.operations[0].before
          : location === 'operation-after' ? raw.operations[0].after
          : raw.turns[0].pages[0][location]!;
        Reflect.deleteProperty(checkpoint, field);
        expect(branchSchema.safeParse(raw).success).toBe(false);
        await expectRepositoryRejection(raw);
        const transfer = JSON.parse(exportBranch(branch));
        transfer.branch = raw;
        expect(() => importBranchFile(JSON.stringify(transfer), launch())).toThrow();
      }
    },
  );

  it('does not broaden compatibility to other missing settings or nested world fields', async () => {
    const branch = await generatedBranch();
    for (const mutate of [
      (raw: V4Branch) => Reflect.deleteProperty(raw.settings, 'speechRate'),
      (raw: V4Branch) => Reflect.deleteProperty(raw.turns[0].pages[0].before!.world.domains, 'inventory'),
      (raw: V4Branch) => Reflect.deleteProperty(raw.turns[0].pages[0].before!.world, 'simulationDay'),
    ]) {
      const raw = oldBranch(branch);
      mutate(raw);
      expect(branchSchema.safeParse(raw).success).toBe(false);
      await expectRepositoryRejection(raw);
    }
  });

  it.each([null, '20', 11, 33, 20.5])('rejects an explicitly invalid font preference: %s', async (value) => {
    const branch = await generatedBranch();
    const raw = oldBranch(branch);
    Object.assign(raw.settings, { generatedTextFontSize: value });
    expect(branchSchema.safeParse(raw).success).toBe(false);
    await expectRepositoryRejection(raw);
    const transfer = JSON.parse(exportBranch(branch));
    transfer.branch = raw;
    expect(() => importBranchFile(JSON.stringify(transfer), launch())).toThrow();
  });
});
