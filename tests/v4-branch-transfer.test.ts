import { describe, expect, it } from 'vitest';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createV4Session, operateWorld } from '../src/v4/runtime/session';
import { createRootBranch, forkBranch, generationBranchTurn, projectBranch, type V4Branch } from '../src/v4/runtime/branches';
import { exportBranch, inspectBranchFile, importBranchFile, branchExportFilename } from '../src/v4/storage/branch-transfer';
import { MAX_V4_FILE_BYTES } from '../src/v4/storage/session';
import { MockProvider } from '../src/runtime/providers/mock';
import { v2Package } from './v2-fixtures';

const launch = () => publicV4Package(v2Package());
const root = () => createRootBranch(createV4Session(launch()));
const generated = () => generationBranchTurn({ ...root(), draft: '*I wait for one minute.*' }, launch(), new MockProvider());
const raw = (value: unknown) => JSON.stringify(value);

// Actual V3-compatible wire identity, constructed locally without importing a sibling runtime.
async function legacyFile() {
  const session = projectBranch(await generated(), launch());
  const { launch: _launch, id: _id, ...state } = session;
  return { ...state, format: 'speculus-v2-session', version: 2, engine: 'v2', source: {
    id: session.launch.primaryAsset.id, type: session.launch.primaryAsset.type, revision: session.launch.primaryAsset.revision,
    persona: { id: session.launch.persona.id }, character: session.launch.character ? { id: session.launch.character.id } : null,
  } };
}

describe('V4 independent canonical branch transfers', () => {
  it('preserves story, branch, parent, lineage, selected pages and every inactive complete page', async () => {
    const parent = await generated();
    const branch = forkBranch(parent, parent.turns[0].id);
    const inactive = structuredClone(branch.turns[0].pages[0]);
    inactive.id = 'inactive-page'; inactive.reply = 'INACTIVE STORY MUST SURVIVE';
    branch.turns[0].pages.unshift(inactive);
    const exported = exportBranch(branch, launch());
    expect(JSON.parse(exported)).toMatchObject({ format: 'speculus-v4-session', version: 4, engine: 'v4', schemaVersion: 4 });
    expect(importBranchFile(exported, launch())).toEqual(branch);
    expect(inspectBranchFile(exported)).toEqual({ id: branch.source.sourceId, type: branch.source.sourceType,
      revision: branch.source.sourceRevision, persona: { id: branch.source.personaId }, character: { id: branch.source.subjectId } });
    expect(branchExportFilename(branch)).toContain(branch.branchId);
    expect(branchExportFilename({ ...branch, label: '../../unsafe name' })).not.toMatch(/[\/\\]/);
  });

  it('rejects source, membership, lineage, frontier, incomplete checkpoints and descendant ledger tampering', async () => {
    const branch = await generated();
    for (const mutate of [
      (b: V4Branch) => { b.turns[0].activePageId = 'absent'; },
      (b: V4Branch) => { b.lineage = [b.branchId]; },
      (b: V4Branch) => { b.frontier = null; },
      (b: V4Branch) => { b.turns[0].pages[0].before = null; },
      (b: V4Branch) => { b.turns[0].pages[0].resolved!.world.revision += 1; },
      (b: V4Branch) => { b.turns[0].pages[0].before!.events.push(b.head.events.at(-1)!); },
      (b: V4Branch) => { b.head.world.actors[0].id = 'unknown'; },
    ]) {
      const transfer = JSON.parse(exportBranch(branch)); mutate(transfer.branch);
      expect(() => importBranchFile(raw(transfer), launch())).toThrow();
    }
    const transfer = JSON.parse(exportBranch(branch)); transfer.source.persona.id = 'wrong';
    expect(() => inspectBranchFile(raw(transfer))).toThrow('source');
    expect(() => importBranchFile(exportBranch(branch), { ...launch(), persona: { ...launch().persona, id: 'wrong' } })).toThrow('source');
    expect(() => importBranchFile(exportBranch(branch), { ...launch(), character: null })).toThrow('source');
  });

  it('redacts known launch authorization and bearer diagnostics without mutating original history', async () => {
    const branch = await generated();
    const authorization = { ...launch(), generationGrant: 'known-authorization-grant' };
    const diagnostics = branch.turns[0].pages[0].diagnostics;
    diagnostics.prompt += `\nlaunch=${authorization.launchId} Authorization: Bearer secret-token`;
    diagnostics.warnings.push('Bearer another-token', 'api_key=private-key');
    diagnostics.warnings.push(`grant echo: ${authorization.generationGrant}`);
    diagnostics.providerEndpoint = 'https://provider.invalid/generate?token=private-url-token';
    const unsafe = diagnostics as unknown as Record<string, unknown>;
    unsafe.providerMetadata = { authorization: 'secret-token', message: authorization.launchId };
    const original = raw(branch);
    const exported = exportBranch(branch, authorization);
    for (const secret of [authorization.launchId, authorization.generationGrant, 'secret-token', 'another-token', 'private-key', 'private-url-token', 'providerMetadata']) expect(exported).not.toContain(secret);
    expect(exported).not.toMatch(/"(?:launch|launchId|generationGrant|authorization|cookie|expiresAt)"/i);
    expect(raw(branch)).toBe(original);
    expect(importBranchFile(exported, authorization).branchId).toBe(branch.branchId);
  });

  it('rejects recursively hidden authorization on import and credentials outside diagnostics on export', () => {
    for (const key of ['launchId', 'generationGrant', 'authorization', 'cookies', 'providerCredentials', 'api_key', 'access_token', 'expiresAt']) {
      const transfer = JSON.parse(exportBranch(root()));
      transfer.branch.head.world.extra = { harmless: [{ [key]: 'private' }] };
      expect(() => inspectBranchFile(raw(transfer))).toThrow('Authorization');
      expect(() => importBranchFile(raw(transfer), launch())).toThrow('Authorization');
    }
    const branch = root(); branch.draft = 'Bearer secret';
    expect(() => exportBranch(branch)).toThrow('Authorization');
  });

  it('preserves original V3 world, ledger, relationships, proposals and marks historical pages unverifiable', async () => {
    const file = await legacyFile();
    const flat = { ...createV4Session(launch()), ...file, version: 4 as const, engine: 'v4' as const };
    const changed = operateWorld(flat, { type: 'record-knowledge', actorId: launch().persona.id, fact: 'authoritative saved fact' });
    file.world = changed.world; file.events = changed.events;
    const branch = importBranchFile(raw(file), launch());
    expect(branch.head.world).toEqual(file.world);
    expect(branch.head.events).toEqual(file.events);
    expect(branch.head.relationships).toEqual(file.relationships);
    expect(branch.head.stateProposals).toEqual(file.stateProposals);
    expect(branch.turns[0].pages[0]).toMatchObject({ before: null, resolved: null, after: null, resolution: null });
    expect(() => forkBranch(branch, branch.turns[0].id)).toThrow('unverifiable');
    expect(importBranchFile(exportBranch(branch), launch())).toEqual(branch);
  });

  it('rejects original invalid actors and event worlds before migration can silently repair them', async () => {
    const file = await legacyFile();
    file.world.actors[0].id = 'not-the-persona';
    expect(() => importBranchFile(raw(file), launch())).toThrow('packaged actors');
    const other = await legacyFile();
    const flat = { ...createV4Session(launch()), ...other, version: 4 as const, engine: 'v4' as const };
    const changed = operateWorld(flat, { type: 'advance-clock', seconds: 1 });
    other.world = changed.world; other.events = changed.events;
    other.events.at(-1)!.world!.actors.pop();
    expect(() => importBranchFile(raw(other), launch())).toThrow('packaged actors');
  });

  it('rejects incomplete authority but permits genuinely absent historical optional collections', async () => {
    const file: Record<string, unknown> = await legacyFile();
    delete file.relationships; delete file.stateProposals;
    expect(importBranchFile(raw(file), launch()).head).toMatchObject({ relationships: {}, stateProposals: [] });
    file.relationships = { pair: { characterId: launch().character!.id, personaId: launch().persona.id } };
    expect(() => importBranchFile(raw(file), launch())).toThrow('authoritative relationships');
    file.relationships = {}; file.stateProposals = [{ id: 'broken', sourceTurnId: 'absent' }];
    expect(() => importBranchFile(raw(file), launch())).toThrow();
  });

  it('wraps flat V4 baseline explicitly without fabricating checkpoints and preserves supplied story ID', async () => {
    const file = { ...await legacyFile(), format: 'speculus-v4-session', version: 4, engine: 'v4', id: 'existing-story' };
    const branch = importBranchFile(raw(file), launch());
    expect(branch.storyId).toBe('existing-story');
    expect(branch.turns[0].pages[0].after).toBeNull();
  });

  it('enforces byte size on import and full export without pruning inactive pages', async () => {
    expect(() => inspectBranchFile(' '.repeat(MAX_V4_FILE_BYTES + 1))).toThrow('16 MB');
    const branch = await generated();
    const page = branch.turns[0].pages[0];
    page.diagnostics.prompt = 'x'.repeat(500_000);
    for (let i = 0; i < 34; i++) branch.turns[0].pages.push({ ...structuredClone(page), id: `inactive-${i}` });
    expect(() => exportBranch(branch)).toThrow('No history was pruned');
    expect(branch.turns[0].pages).toHaveLength(35);
  });
});
