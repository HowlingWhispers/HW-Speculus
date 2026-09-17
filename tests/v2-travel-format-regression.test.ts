import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v2/contracts/launch';
import { normalizeV2RoleplayFormat } from '../src/v2/runtime/engine';
import { resolveV2PlayerTurn } from '../src/v2/runtime/resolution';
import { createV2Session } from '../src/v2/runtime/session';
import { v2Package } from './v2-fixtures';

function bitterrootPackage(initialLocationId?: string) {
  return v2Package({
    primaryAsset: {
      id: 'world:bitterroot', type: 'world', revision: 'rev-1', name: 'Bitterroot',
      summary: 'The Bitterroot continent.', data: {},
    },
    character: null,
    ...(initialLocationId ? { initialLocationId } : {}),
    relatedAssets: [
      {
        id: 'place:hollowmere', type: 'place', revision: 'rev-1', name: 'Hollowmere', summary: 'Regional capital.',
        data: { sourceId: 'hollowmere', travelFromHollowmere: { distanceFromHollowmereKm: 0 } },
      },
      {
        id: 'place:brackenjaw', type: 'place', revision: 'rev-1', name: 'Brackenjaw Enclave', summary: 'Mountain enclave.',
        data: { sourceId: 'brackenjaw-enclave', travelFromHollowmere: { distanceFromHollowmereKm: 24 } },
      },
      {
        id: 'place:brackenjaw-ranger-station', type: 'place', revision: 'rev-1', name: 'Brackenjaw Ranger Station', summary: 'Ranger station.',
        data: { sourceId: 'ranger-station', parentLocationId: 'brackenjaw-enclave' },
      },
    ],
    contextBlocks: [],
  });
}

describe('V2 Bitterroot movement regressions', () => {
  it('falls back to packaged Hollowmere when an older Bitterroot launch omits initialLocationId', () => {
    const session = createV2Session(publicV2Package(bitterrootPackage()));
    expect(session.world.locationId).toBe('place:hollowmere');
    expect(session.world.actors.find((actor) => actor.role === 'player')?.locationId).toBe('place:hollowmere');
  });

  it('resolves natural text travel to a nested canonical place and inherits the parent route distance', () => {
    const session = createV2Session(publicV2Package(bitterrootPackage('place:hollowmere')));
    const resolved = resolveV2PlayerTurn(session, '*Travel to Ranger Station in Brackenjaw enclave*');

    expect(resolved.resolution.status).toBe('resolved');
    expect(resolved.resolution.travel?.destinationId).toBe('place:brackenjaw-ranger-station');
    expect(resolved.resolution.travel?.distanceKm).toBe(24);
    expect(resolved.session.world.locationId).toBe('place:brackenjaw-ranger-station');
    expect(resolved.session.world.elapsedSeconds).toBe(21_600);
  });

  it('commits completed first-person past-tense travel to the canonical destination', () => {
    const session = createV2Session(publicV2Package(bitterrootPackage('place:hollowmere')));
    const resolved = resolveV2PlayerTurn(session, '*I traveled to Brackenjaw Ranger Station*');

    expect(resolved.resolution.status).toBe('resolved');
    expect(resolved.resolution.travel?.destinationId).toBe('place:brackenjaw-ranger-station');
    expect(resolved.session.world.locationId).toBe('place:brackenjaw-ranger-station');
    expect(resolved.session.world.elapsedSeconds).toBe(21_600);
    expect(resolved.resolution.appliedActions[0]).toContain('travel:Hollowmere->Brackenjaw Ranger Station');
  });

  it('does not spend generic turn time when an explicit travel destination cannot resolve', () => {
    const session = createV2Session(publicV2Package(bitterrootPackage('place:hollowmere')));
    const resolved = resolveV2PlayerTurn(session, 'Travel to Somewhere That Is Not Packaged');

    expect(resolved.resolution.status).toBe('deferred');
    expect(resolved.resolution.elapsedSeconds).toBe(0);
    expect(resolved.session.world.revision).toBe(0);
    expect(resolved.session.world.elapsedSeconds).toBe(0);
    expect(resolved.session.world.locationId).toBe('place:hollowmere');
  });
});

describe('V2 roleplay formatting regression', () => {
  it('removes accidental dialogue wrapper italics while preserving action italics', () => {
    const raw = '*"The old people," *she begins, her voice low and steady,* "they spoke of the world as Harthmar."*\n\n*"Do you like it?" *he asks.* "Harthmar?"*';
    const normalized = normalizeV2RoleplayFormat(raw);

    expect(normalized).toContain('"The old people," *she begins, her voice low and steady,* "they spoke of the world as Harthmar."');
    expect(normalized).toContain('"Do you like it?" *he asks.* "Harthmar?"');
    expect(normalized).not.toContain('*"');
    expect(normalized).not.toContain('"*');
  });
});
