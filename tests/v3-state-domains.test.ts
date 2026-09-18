import { describe, expect, it } from 'vitest';
import { emptyRuntimeDomains, runtimeDomainsSchema } from '../src/v3/runtime/state-domains';
import { worldSchema } from '../src/v3/runtime/world';

describe('V3 runtime state domains', () => {
  it('starts every mutable gameplay domain empty and explicit', () => {
    expect(emptyRuntimeDomains()).toEqual({
      inventory: [],
      relationships: [],
      resources: [],
      conditions: [],
      mysteries: [],
      chronicle: [],
    });
  });

  it('upgrades a V2-shaped world snapshot with empty V3 domains', () => {
    const world = worldSchema.parse({
      revision: 0,
      elapsedSeconds: 0,
      simulationDay: 1,
      timeOfDaySeconds: 28_800,
      locationId: null,
      actors: [],
    });
    expect(world.domains).toEqual(emptyRuntimeDomains());
  });

  it('rejects duplicate runtime identities instead of silently merging them', () => {
    const item = {
      instanceId: 'item-instance-1',
      canonicalItemId: 'canonical-item-1',
      ownerActorId: 'actor-1',
      containerId: null,
      quantity: 1,
      equipped: false,
      condition: null,
    };
    expect(runtimeDomainsSchema.safeParse({ inventory: [item, item] }).success).toBe(false);

    const relationship = {
      id: 'relationship-1',
      actorIds: ['actor-1', 'actor-2'],
      stage: null,
      factors: {},
      events: [],
    };
    expect(runtimeDomainsSchema.safeParse({ relationships: [relationship, relationship] }).success).toBe(false);
  });

  it('rejects self-relationships', () => {
    const result = runtimeDomainsSchema.safeParse({
      relationships: [{
        id: 'relationship-1',
        actorIds: ['actor-1', 'actor-1'],
        stage: null,
        factors: {},
        events: [],
      }],
    });
    expect(result.success).toBe(false);
  });
});
