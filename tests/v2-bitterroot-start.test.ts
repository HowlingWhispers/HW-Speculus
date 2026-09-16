import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v2/contracts/launch';
import { createV2Session } from '../src/v2/runtime/session';
import { v2Package } from './v2-fixtures';

describe('Bitterroot starter location', () => {
  it('starts a fresh Bitterroot character session in canonical Hollowmere', () => {
    const pack = v2Package({
      initialLocationId: 'place:hollowmere',
      relatedAssets: [
        { id: 'world:bitterroot', type: 'world', revision: 'rev-1', name: 'Bitterroot', summary: 'Dark fantasy world.', data: {} },
        { id: 'place:hollowmere', type: 'place', revision: 'rev-1', name: 'Hollowmere', summary: 'Regional capital.', data: { sourceId: 'hollowmere', travelFromHollowmere: { distanceFromHollowmereKm: 0 } } },
      ],
      contextBlocks: [],
    });
    const session = createV2Session(publicV2Package(pack));
    expect(session.world.locationId).toBe('place:hollowmere');
    expect(session.world.actors.find((actor) => actor.role === 'player')?.locationId).toBe('place:hollowmere');
    expect(session.world.actors.find((actor) => actor.role === 'character')?.locationId).toBeNull();
  });

  it('keeps legacy packages without an initial location unanchored', () => {
    const session = createV2Session(publicV2Package(v2Package()));
    expect(session.world.locationId).toBeNull();
  });
});
