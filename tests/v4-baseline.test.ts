import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { publicV4Package, v4LaunchSchema } from '../src/v4/contracts/launch';
import { createV4Session } from '../src/v4/runtime/session';
import { generateV4Turn } from '../src/v4/runtime/engine';
import { compileV4Context } from '../src/v4/runtime/context';
import { isSkippedPersonaTurn, skippedPersonaActorId } from '../src/v4/runtime/turn-control';
import { exportV4Session, importV4Session, inspectV4Session, loadV4Session, saveV4Session, V4_EXPORT_FORMAT, V4_STORAGE_KEY } from '../src/v4/storage/session';
import { loadLatestV4LocalAutosave, saveV4LocalAutosave, V4_AUTOSAVE_PREFIX } from '../src/v4/storage/autosave';
import { detachedTranscriptChannelName } from '../src/v4/ui/detached-channel';
import { publicV2Package } from '../src/v3/contracts/launch';
import { createV2Session } from '../src/v3/runtime/session';
import { generateV2Turn } from '../src/v3/runtime/engine';
import { exportV2Session } from '../src/v3/storage/session';
import { MockProvider } from '../src/runtime/providers/mock';
import { v2Package } from './v2-fixtures';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
const fresh = () => createV4Session(publicV4Package(v2Package()));

describe('V4 flat client baseline', () => {
  it('separates runtime identity from unchanged launch wire identity', () => {
    const session = fresh();
    expect(session).toMatchObject({ version: 4, engine: 'v4', turns: [], nextTurn: 1 });
    expect(session.launch).toMatchObject({ version: 2, engine: 'v2' });
    expect(v4LaunchSchema.safeParse({ ...v2Package(), version: 4, engine: 'v4' }).success).toBe(false);
    expect(session).not.toHaveProperty('branches');
    expect(session.settings).not.toHaveProperty('speechEnabled');
  });

  it('generates V4 turns/context and round-trips authorization-free V4 saves', async () => {
    const session = await generateV4Turn({ ...fresh(), draft: '*I look around.*' }, new MockProvider());
    expect(session.turns[0].id).toMatch(/^v4:/);
    expect(session.turns[0]).not.toHaveProperty('pages');
    expect(compileV4Context(session, '*I wait.*').prompt).toMatch(/^SPECULUS V4/);
    const raw = exportV4Session(session);
    expect(JSON.parse(raw)).toMatchObject({ format: V4_EXPORT_FORMAT, version: 4, engine: 'v4' });
    expect(raw).not.toContain(session.launch.launchId);
    expect(raw).not.toMatch(/"(?:generationGrant|expiresAt|launchId)"/);
    expect(importV4Session(raw, fresh()).turns).toEqual(session.turns);
    expect(inspectV4Session(raw).id).toBe(session.launch.primaryAsset.id);
  });

  it('migrates actual V3 exports locally preserving transcript, world, ledger and proposals', async () => {
    let legacy = createV2Session(publicV2Package(v2Package()));
    legacy = await generateV2Turn({ ...legacy, draft: '*I wait.*' }, new MockProvider());
    legacy = await generateV2Turn(legacy, new MockProvider(), { skipPersona: true });
    const raw = exportV2Session(legacy);
    const imported = importV4Session(raw, fresh());
    expect(imported).toMatchObject({ version: 4, engine: 'v4' });
    expect(imported.world).toEqual(legacy.world);
    expect(imported.events).toEqual(legacy.events);
    expect(imported.relationships).toEqual(legacy.relationships);
    expect(imported.stateProposals).toEqual(legacy.stateProposals);
    expect(imported.turns[0]).toEqual(legacy.turns[0]);
    expect(imported.turns[1].reply).toBe(legacy.turns[1].reply);
    expect(imported.turns[1].player).toBe('__speculus_v4_persona_turn_skipped__');
    expect(isSkippedPersonaTurn(imported.turns[1].player)).toBe(true);
    expect(JSON.parse(raw).version).toBe(2);
    expect(JSON.parse(exportV4Session(imported)).version).toBe(4);
  });

  it('normalizes V3 Skip-as markers and retains older optional-field migration', async () => {
    const legacy = await generateV2Turn({ ...createV2Session(publicV2Package(v2Package())), draft: '*I wait.*' }, new MockProvider());
    const value = JSON.parse(exportV2Session(legacy));
    value.turns[0].player = '__speculus_v3_persona_turn_skipped_as__:character:test';
    delete value.relationships;
    delete value.stateProposals;
    delete value.turns[0].diagnostics.warnings;
    const imported = importV4Session(JSON.stringify(value), fresh());
    expect(skippedPersonaActorId(imported.turns[0].player)).toBe('character:test');
    expect(imported.turns[0].diagnostics.warnings).toEqual([]);
    expect(imported.relationships).toEqual({});
    expect(imported.stateProposals).toEqual([]);
  });

  it('rejects invalid files, mismatched canon and inconsistent ledgers without mutating the session', async () => {
    const current = fresh();
    const original = JSON.stringify(current);
    expect(() => inspectV4Session('{')).toThrow('not valid JSON');
    expect(() => inspectV4Session(JSON.stringify({ format: 'speculus-session', version: 1 }))).toThrow('V1');
    const value = JSON.parse(exportV4Session(current));
    value.source.revision = 'other';
    expect(() => importV4Session(JSON.stringify(value), current)).toThrow('same Orbis record');
    const generated = await generateV4Turn({ ...current, draft: '*I wait.*' }, new MockProvider());
    const broken = JSON.parse(exportV4Session(generated));
    broken.turns[0].worldRevision = 999;
    expect(() => importV4Session(JSON.stringify(broken), current)).toThrow('inconsistent world revision');
    expect(JSON.stringify(current)).toBe(original);
  });

  it('reads/writes only V4 session/autosave keys and isolates reader channels', () => {
    sessionStorage.setItem('speculus.session.v3.experimental', 'frozen-v3');
    localStorage.setItem('speculus.autosave.v3.experimental:last', 'frozen-v3');
    expect(loadV4Session()).toBeNull();
    expect(loadLatestV4LocalAutosave()).toBeNull();
    const session = fresh();
    saveV4Session(session);
    const saved = saveV4LocalAutosave(session);
    expect(saved.key.startsWith(V4_AUTOSAVE_PREFIX)).toBe(true);
    expect(loadV4Session()).toEqual(session);
    expect(loadLatestV4LocalAutosave()?.raw).toBe(saved.raw);
    expect(sessionStorage.getItem(V4_STORAGE_KEY)).toBeTruthy();
    expect(sessionStorage.getItem('speculus.session.v3.experimental')).toBe('frozen-v3');
    expect(localStorage.getItem('speculus.autosave.v3.experimental:last')).toBe('frozen-v3');
    expect(detachedTranscriptChannelName(session.id)).toBe(`speculus-v4-transcript:${session.id}`);
  });

  it('contains no sibling runtime imports and preserves inherited styles', () => {
    function check(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) check(file);
        else if (/\.tsx?$/.test(file)) {
          expect(readFileSync(file, 'utf8')).not.toMatch(/(?:from\s+|import\s*\()['"][^'"]*\/v[123]\//);
        }
      }
    }
    check('src/v4');
    for (const name of ['terminal.css', 'roleplay-colors.css', 'detached.css', 'autosave.css']) {
      expect(readFileSync(`src/v4/ui/${name}`, 'utf8')).toBe(readFileSync(`src/v3/ui/${name}`, 'utf8'));
    }
  });
});
