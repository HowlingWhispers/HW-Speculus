import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v3/contracts/launch';
import { createV2Session } from '../src/v3/runtime/session';
import { generateV2Turn } from '../src/v3/runtime/engine';
import { exportV2Session, importV2Session, inspectV2Session, SpeculusImportError } from '../src/v3/storage/session';
import { MockProvider } from '../src/runtime/providers/mock';
import { v2Package } from './v2-fixtures';

function launch() {
  return publicV2Package(v2Package({
    primaryAsset: { id: 'world:bitterroot', type: 'world', revision: 'rev-1', name: 'Bitterroot', summary: 'A world.', data: {} },
    character: null,
    initialLocationId: 'place:hollowmere',
    relatedAssets: [{ id: 'place:hollowmere', type: 'place', revision: 'rev-1', name: 'Hollowmere', summary: 'A town.', data: {} }],
  } as never));
}

async function sessionWithTurn() {
  const session = { ...createV2Session(launch()), draft: 'I look around the square.' };
  return generateV2Turn(session, new MockProvider(), {});
}

function messageOf(fn: () => unknown) {
  try { fn(); return 'NO THROW'; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
}

describe('V3 import compatibility pass', () => {
  it('1. current export imports successfully', async () => {
    const session = await sessionWithTurn();
    const next = importV2Session(exportV2Session(session), session);
    expect(next.turns).toHaveLength(session.turns.length);
    expect(next.world.revision).toBe(session.world.revision);
  });

  it('2. current export inspects successfully', async () => {
    const session = await sessionWithTurn();
    const source = inspectV2Session(exportV2Session(session));
    expect(source.id).toBe('world:bitterroot');
    expect(source.revision).toBe('rev-1');
  });

  it('3. an older export missing newer defaultable fields migrates and imports', async () => {
    const session = await sessionWithTurn();
    const parsed = JSON.parse(exportV2Session(session)) as Record<string, unknown>;
    delete parsed.stateProposals;
    delete parsed.relationships;
    for (const turn of parsed.turns as Array<Record<string, unknown>>) {
      const diagnostics = turn.diagnostics as Record<string, unknown>;
      delete diagnostics.included;
      delete diagnostics.omitted;
      delete diagnostics.issues;
      delete diagnostics.warnings;
      delete diagnostics.outputCompliance;
      delete diagnostics.continuity;
    }
    const next = importV2Session(JSON.stringify(parsed), session);
    expect(next.turns).toHaveLength(session.turns.length);
    expect(next.stateProposals).toEqual([]);
  });

  it('4. missing stateProposals defaults safely to []', async () => {
    const session = await sessionWithTurn();
    const parsed = JSON.parse(exportV2Session(session)) as Record<string, unknown>;
    delete parsed.stateProposals;
    const next = importV2Session(JSON.stringify(parsed), session);
    expect(Array.isArray(next.stateProposals)).toBe(true);
    expect(next.stateProposals).toHaveLength(0);
  });

  it('5. invalid JSON reports invalid JSON, never V1', () => {
    const message = messageOf(() => inspectV2Session('{ not json'));
    expect(message).toBe('Import failed: this file is not valid JSON.');
    expect(message).not.toContain('V1');
  });

  it('6. an unknown JSON file is an unrecognized Speculus export', () => {
    const message = messageOf(() => inspectV2Session(JSON.stringify({ hello: 'world' })));
    expect(message).toBe('This file is not a recognized Speculus session export.');
    expect(message).not.toContain('V1');
  });

  it('7. a known V1 fixture gets the V1-specific message', () => {
    for (const format of ['speculus-session', 'speculus-raw-session']) {
      const message = messageOf(() => inspectV2Session(JSON.stringify({ format, version: 1, state: {} })));
      expect(message).toBe('This is a V1 save. V1 files must stay in V1.');
    }
  });

  it('8. a recognized V2/V3 export with corrupted authoritative state is reported as incompatible, not V1', async () => {
    const session = await sessionWithTurn();
    const parsed = JSON.parse(exportV2Session(session)) as Record<string, unknown>;
    const turns = parsed.turns as Array<Record<string, unknown>>;
    turns[0].worldRevision = 999;
    const message = messageOf(() => importV2Session(JSON.stringify(parsed), session));
    expect(message).not.toContain('V1');
    expect(message).toContain('V2 turn references an inconsistent world revision');
  });

  it('8b. a recognized V2/V3 export that cannot satisfy the current schema names the compatibility problem', async () => {
    const session = await sessionWithTurn();
    const parsed = JSON.parse(exportV2Session(session)) as Record<string, unknown>;
    delete (parsed as Record<string, unknown>).events;
    let caught: SpeculusImportError | null = null;
    try { importV2Session(JSON.stringify(parsed), session); } catch (cause) { caught = cause as SpeculusImportError; }
    expect(caught).toBeInstanceOf(SpeculusImportError);
    expect(caught!.message).toBe('Speculus recognized this as a V2/V3 session export, but it could not be migrated to the current save schema.');
    expect(caught!.message).not.toContain('V1');
    // detail carries the actionable path, without dumping raw zod output
    expect(caught!.detail).toContain('events');
    expect(caught!.detail!.length).toBeLessThan(200);
  });

  it('9. source/revision mismatch is still rejected after migration', async () => {
    const session = await sessionWithTurn();
    const parsed = JSON.parse(exportV2Session(session)) as Record<string, unknown>;
    delete parsed.stateProposals;
    (parsed.source as Record<string, unknown>).revision = 'rev-OLD';
    const message = messageOf(() => importV2Session(JSON.stringify(parsed), session));
    expect(message).toBe('Import requires the same Orbis record and canonical revision. No session was changed.');
  });

  it('10. round-trips within the same build: export then immediately import', async () => {
    const session = await sessionWithTurn();
    const raw = exportV2Session(session);
    const source = inspectV2Session(raw);
    const reimported = importV2Session(raw, session);
    expect(source.id).toBe(session.launch.primaryAsset.id);
    expect(reimported.turns.map((turn) => turn.id)).toEqual(session.turns.map((turn) => turn.id));
    expect(reimported.turns.map((turn) => turn.reply)).toEqual(session.turns.map((turn) => turn.reply));
    // a second round-trip is byte-stable for a fixed export timestamp
    expect(exportV2Session(reimported, 1_700_000_000_000)).toBe(exportV2Session(session, 1_700_000_000_000));
  });

  it('imports inside an already-running session path', async () => {
    const session = await sessionWithTurn();
    // advance the live session, then import the earlier save over it
    const advanced = await generateV2Turn({ ...session, draft: 'I keep walking.' }, new MockProvider(), {});
    const restored = importV2Session(exportV2Session(session), advanced);
    expect(restored.turns).toHaveLength(session.turns.length);
    expect(restored.turns.at(-1)!.id).toBe(session.turns.at(-1)!.id);
  });

  it('staged root import path inspects before launching back through Orbis', async () => {
    const session = await sessionWithTurn();
    const raw = exportV2Session(session);
    // root/staged import: inspect only, no session required
    const staged = inspectV2Session(raw);
    expect(staged.persona).toBeDefined();
    expect(staged.type).toBe('world');
    // then the same staged raw imports cleanly into a fresh launch session
    const fresh = createV2Session(launch());
    const next = importV2Session(raw, fresh);
    expect(next.turns).toHaveLength(session.turns.length);
  });
});
