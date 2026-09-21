import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v3/contracts/launch';
import { generateV2Turn } from '../src/v3/runtime/engine';
import { acceptStateProposal, rejectStateProposal } from '../src/v3/runtime/state-review';
import { createV2Session, deleteLastTurn } from '../src/v3/runtime/session';
import { exportV2Session, importV2Session } from '../src/v3/storage/session';
import { MockProvider } from '../src/runtime/providers/mock';
import type { ProviderRequest } from '../src/runtime/providers/types';
import { v2Package } from './v2-fixtures';

class InventoryOutcomeProvider extends MockProvider {
  override async generate(request: ProviderRequest) {
    const result = await super.generate(request);
    return {
      ...result,
      text: '*You pick up the Rope and secure it in your hand.*',
    };
  }
}

function launchWithRope() {
  return publicV2Package(v2Package({
    relatedAssets: [
      { id: 'place:workshop', type: 'place', revision: 'rev-1', name: 'Workshop', summary: 'A quiet workshop.', data: {} },
      { id: 'item:rope', type: 'item', revision: 'rev-1', name: 'Rope', summary: 'A coil of rope.', data: {} },
    ],
  }));
}

describe('V3 state reconciliation review', () => {
  it('keeps prose-derived inventory changes pending until explicitly accepted', async () => {
    let session = createV2Session(launchWithRope());
    session.draft = '*I reach toward the rope.*';
    session = await generateV2Turn(session, new InventoryOutcomeProvider(), { now: 1_800_000_300_000 });

    expect(session.world.domains.inventory).toEqual([]);
    expect(session.stateProposals).toHaveLength(1);
    expect(session.stateProposals[0]).toMatchObject({
      kind: 'inventory-add',
      canonicalItemId: 'item:rope',
      ownerActorId: session.launch.persona.id,
      quantity: 1,
    });

    const revisionBeforeReject = session.world.revision;
    const rejected = rejectStateProposal(session, session.stateProposals[0].id);
    expect(rejected.stateProposals).toEqual([]);
    expect(rejected.world.revision).toBe(revisionBeforeReject);
    expect(rejected.world.domains.inventory).toEqual([]);
  });

  it('persists pending review and rolls accepted turn-owned state back on reroll/delete', async () => {
    const provider = new InventoryOutcomeProvider();
    let session = createV2Session(launchWithRope());
    session.draft = '*I reach toward the rope.*';
    session = await generateV2Turn(session, provider, { now: 1_800_000_310_000 });
    const sourceTurnId = session.turns.at(-1)!.id;
    const proposalId = session.stateProposals[0].id;

    const raw = exportV2Session(session, 1_800_000_310_050);
    const fresh = createV2Session(publicV2Package(v2Package({
      launchId: 'fresh-state-review-launch',
      relatedAssets: [
        { id: 'place:workshop', type: 'place', revision: 'rev-1', name: 'Workshop', summary: 'A quiet workshop.', data: {} },
        { id: 'item:rope', type: 'item', revision: 'rev-1', name: 'Rope', summary: 'A coil of rope.', data: {} },
      ],
    })));
    session = importV2Session(raw, fresh);
    expect(session.stateProposals).toHaveLength(1);

    session = acceptStateProposal(session, proposalId);
    expect(session.stateProposals).toEqual([]);
    expect(session.world.domains.inventory).toHaveLength(1);
    expect(session.events.at(-1)).toMatchObject({
      kind: 'operator',
      label: 'inventory-add',
      ownerTurnId: sourceTurnId,
    });

    session = await generateV2Turn(session, provider, { reroll: true, now: 1_800_000_310_100 });
    expect(session.world.domains.inventory).toEqual([]);
    expect(session.stateProposals).toHaveLength(1);
    expect(session.stateProposals[0].sourceTurnId).toBe(sourceTurnId);
    expect(session.events.some((event) => event.kind === 'operator' && event.ownerTurnId === sourceTurnId)).toBe(false);

    session = acceptStateProposal(session, session.stateProposals[0].id);
    expect(session.world.domains.inventory).toHaveLength(1);

    session = deleteLastTurn(session);
    expect(session.turns).toEqual([]);
    expect(session.stateProposals).toEqual([]);
    expect(session.world.domains.inventory).toEqual([]);
    expect(session.world.revision).toBe(0);
  });
});
