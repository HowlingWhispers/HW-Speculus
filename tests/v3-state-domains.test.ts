import { describe, expect, it } from 'vitest';
import { emptyRuntimeDomains, runtimeDomainsSchema } from '../src/v3/runtime/state-domains';
import { applyWorldAction, worldSchema } from '../src/v3/runtime/world';
import { publicV2Package } from '../src/v3/contracts/launch';
import { createV2Session, operateWorld } from '../src/v3/runtime/session';
import { exportV2Session, importV2Session } from '../src/v3/storage/session';
import { compileV2Context } from '../src/v3/runtime/context';
import { v2Package } from './v2-fixtures';

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

  it('adds only canonical packaged items and preserves equip/remove state through world revisions', () => {
    const base = v2Package({
      relatedAssets: [
        { id: 'place:workshop', type: 'place', revision: 'rev-1', name: 'Workshop', summary: 'A quiet workshop.', data: {} },
        { id: 'item:rope', type: 'item', revision: 'rev-1', name: 'Rope', summary: 'A coil of rope.', data: {} },
      ],
    });
    const session = createV2Session(publicV2Package(base));
    const playerId = session.launch.persona.id;

    const withItem = operateWorld(session, {
      type: 'inventory-add',
      instanceId: 'inventory:rope:1',
      canonicalItemId: 'item:rope',
      ownerActorId: playerId,
      quantity: 2,
      equipped: false,
    });
    const added = withItem.world;

    expect(added.revision).toBe(1);
    expect(withItem.events.at(-1)?.label).toBe('inventory-add');
    expect(added.domains.inventory).toEqual([{
      instanceId: 'inventory:rope:1',
      canonicalItemId: 'item:rope',
      ownerActorId: playerId,
      containerId: null,
      quantity: 2,
      equipped: false,
      condition: null,
    }]);

    const equippedSession = operateWorld(withItem, {
      type: 'inventory-set-equipped',
      instanceId: 'inventory:rope:1',
      equipped: true,
    });
    const equipped = equippedSession.world;
    expect(equipped.revision).toBe(2);
    expect(equipped.domains.inventory[0].equipped).toBe(true);

    const packet = compileV2Context(equippedSession, '*I check my gear.*');
    expect(packet.prompt).toContain('ENGINE INVENTORY STATE / READ ONLY');
    expect(packet.prompt).toContain('"item":"Rope"');
    expect(packet.prompt).toContain('"quantity":2');

    const raw = exportV2Session(equippedSession, 1_800_000_200_000);
    const restored = importV2Session(raw, createV2Session(publicV2Package(base)));
    expect(restored.world.domains.inventory[0].equipped).toBe(true);
    expect(restored.world.domains.inventory[0].quantity).toBe(2);

    const removedSession = operateWorld(restored, {
      type: 'inventory-remove',
      instanceId: 'inventory:rope:1',
    });
    expect(removedSession.world.revision).toBe(3);
    expect(removedSession.world.domains.inventory).toEqual([]);
  });

  it('rejects fabricated inventory item and owner identities', () => {
    const base = v2Package({
      relatedAssets: [
        { id: 'item:rope', type: 'item', revision: 'rev-1', name: 'Rope', summary: 'A coil of rope.', data: {} },
      ],
    });
    const session = createV2Session(publicV2Package(base));

    expect(() => applyWorldAction(session.world, {
      type: 'inventory-add',
      instanceId: 'inventory:fake:1',
      canonicalItemId: 'item:not-packaged',
      ownerActorId: session.launch.persona.id,
      quantity: 1,
      equipped: false,
    }, session.launch)).toThrow('canonical items supplied by Orbis');

    expect(() => applyWorldAction(session.world, {
      type: 'inventory-add',
      instanceId: 'inventory:rope:1',
      canonicalItemId: 'item:rope',
      ownerActorId: 'actor:not-packaged',
      quantity: 1,
      equipped: false,
    }, session.launch)).toThrow('packaged actor');
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
