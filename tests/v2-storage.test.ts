import { beforeEach, describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v2/contracts/launch';
import { createV2Session, operateWorld } from '../src/v2/runtime/session';
import { exportV2Session, importV2Session, inspectV2Session, loadV2Session, saveV2Session, V2_STORAGE_KEY, v2ExportFilename } from '../src/v2/storage/session';
import { v2Package } from './v2-fixtures';
import { parseRawSession } from '../src/storage/session-transfer';

const fresh = () => createV2Session(publicV2Package(v2Package()));
beforeEach(() => sessionStorage.clear());
describe('V2 session boundary', () => {
  it('reads and writes only its V2 storage key and round-trips draft/state', () => {
    sessionStorage.setItem('speculus.session.v1', 'V1 untouched');
    const session = operateWorld(fresh(), { type: 'advance-clock', seconds: 30 }); session.draft = 'Not sent';
    saveV2Session(session);
    expect(loadV2Session()).toEqual(session);
    expect(sessionStorage.getItem('speculus.session.v1')).toBe('V1 untouched');
    sessionStorage.removeItem(V2_STORAGE_KEY); expect(loadV2Session()).toBeNull();
  });
  it('exports no launch authorization, identifies its source, and preserves fresh authorization on import', () => {
    const old = fresh(); old.draft = 'Preserve this draft';
    const raw = exportV2Session(old, Date.UTC(2026, 8, 14, 10, 3));
    expect(raw).not.toContain(old.launch.launchId); expect(raw).not.toContain('generationGrant'); expect(raw).not.toContain('expiresAt');
    const identity = inspectV2Session(raw);
    expect(identity.id).toBe(old.launch.primaryAsset.id);
    expect(identity.revision).toBe(old.launch.primaryAsset.revision);
    expect(identity.persona?.name).toBe(old.launch.persona.name);
    expect(identity.elapsedSeconds).toBe(0);
    expect(identity.exportedAt).toBe(Date.UTC(2026, 8, 14, 10, 3));
    const current = createV2Session(publicV2Package(v2Package({ launchId: 'new-launch-authorization' })));
    const restored = importV2Session(raw, current);
    expect(restored.launch).toEqual(current.launch); expect(restored.draft).toBe(old.draft);
  });
  it('creates distinct, readable filenames without making the filename authoritative', () => {
    const value = fresh();
    const first = v2ExportFilename(value, new Date('2026-09-14T10:03:00Z'));
    const second = v2ExportFilename(value, new Date('2026-09-14T10:04:00Z'));
    expect(first).toMatch(/^Speculus_.+_NoLocation_.+_2026-09-14_10-03\.json$/);
    expect(second).not.toBe(first);
  });
  it('rejects V1 files, another source/revision and noncanonical state without changing the current session', () => {
    const current = fresh(); const before = structuredClone(current);
    expect(() => importV2Session('{"version":1}', current)).toThrow('V1');
    expect(() => parseRawSession(exportV2Session(current))).toThrow('not a supported');
    const raw = JSON.parse(exportV2Session(current)); raw.source.revision = 'different';
    expect(() => importV2Session(JSON.stringify(raw), current)).toThrow('same Orbis record');
    raw.source.revision = current.launch.primaryAsset.revision; raw.world.locationId = 'new-city';
    expect(() => importV2Session(JSON.stringify(raw), current)).toThrow('unpackaged');
    expect(current).toEqual(before);
  });
  it('allows an expired session to be loaded and exported, without refreshing its authorization', () => {
    const value = fresh(); value.launch.expiresAt = 1; saveV2Session(value);
    expect(loadV2Session()?.launch.expiresAt).toBe(1);
    expect(exportV2Session(loadV2Session()!)).toContain('speculus-v2-session');
  });
  it('rejects a mismatched world snapshot instead of importing a fabricated ledger', () => {
    const value = operateWorld(fresh(), { type: 'advance-clock', seconds: 30 });
    const raw = JSON.parse(exportV2Session(value)); raw.world.elapsedSeconds = 300;
    expect(() => importV2Session(JSON.stringify(raw), fresh())).toThrow('does not match its operator ledger');
  });
});
