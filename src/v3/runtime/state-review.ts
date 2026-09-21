import { operateWorld, type V2Session } from './session';
import { assetsFor } from './world';
import type { V3StateProposal } from './state-proposals';

const escapeRegExp = (value: string) => value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');

function mentioned(pattern: string, itemName: string, text: string) {
  return new RegExp(\`\\b(?:\${pattern})\\b[^\\n.!?]{0,80}\\b\${escapeRegExp(itemName)}\\b\`, 'i').test(text)
    || new RegExp(\`\\b\${escapeRegExp(itemName)}\\b[^\\n.!?]{0,80}\\b(?:\${pattern})\\b\`, 'i').test(text);
}

export function deriveStateProposals(session: V2Session, sourceTurnId: string, reply: string): V3StateProposal[] {
  const playerId = session.launch.persona.id;
  const items = assetsFor(session.launch).filter((asset) => asset.type === 'item');
  const proposals: V3StateProposal[] = [];

  for (const asset of items) {
    const owned = session.world.domains.inventory.filter((item) => item.ownerActorId === playerId && item.canonicalItemId === asset.id);
    const itemName = asset.name.trim();
    if (!itemName) continue;

    if (owned.length === 0 && mentioned('you (?:now )?(?:take|pick up|picked up|grab|receive|received|accept|accepted|obtain|obtained|acquire|acquired|are given)', itemName, reply)) {
      proposals.push({
        id: \`proposal:\${sourceTurnId}:inventory-add:\${asset.id}\`,
        sourceTurnId,
        kind: 'inventory-add',
        summary: \`Review: the committed reply appears to show \${session.launch.persona.name} receiving canonical item \${asset.name}.\`,
        canonicalItemId: asset.id,
        ownerActorId: playerId,
        quantity: 1,
      });
      continue;
    }

    const firstOwned = owned[0];
    if (!firstOwned) continue;

    if (mentioned('you (?:drop|dropped|discard|discarded|give away|gave away|hand over|handed over|lose|lost)', itemName, reply)) {
      proposals.push({
        id: \`proposal:\${sourceTurnId}:inventory-remove:\${firstOwned.instanceId}\`,
        sourceTurnId,
        kind: 'inventory-remove',
        summary: \`Review: the committed reply appears to show \${session.launch.persona.name} losing or giving up \${asset.name}.\`,
        instanceId: firstOwned.instanceId,
      });
      continue;
    }

    if (!firstOwned.equipped && mentioned('you (?:equip|equipped|wear|wore|put on|strap on|strapped on)', itemName, reply)) {
      proposals.push({
        id: \`proposal:\${sourceTurnId}:inventory-equip:\${firstOwned.instanceId}\`,
        sourceTurnId,
        kind: 'inventory-set-equipped',
        summary: \`Review: the committed reply appears to show \${session.launch.persona.name} equipping \${asset.name}.\`,
        instanceId: firstOwned.instanceId,
        equipped: true,
      });
    } else if (firstOwned.equipped && mentioned('you (?:unequip|unequipped|remove|removed|take off|took off|unstrap|unstrapped)', itemName, reply)) {
      proposals.push({
        id: \`proposal:\${sourceTurnId}:inventory-unequip:\${firstOwned.instanceId}\`,
        sourceTurnId,
        kind: 'inventory-set-equipped',
        summary: \`Review: the committed reply appears to show \${session.launch.persona.name} unequipping \${asset.name}.\`,
        instanceId: firstOwned.instanceId,
        equipped: false,
      });
    }
  }

  return proposals.slice(0, 20);
}

export function acceptStateProposal(session: V2Session, proposalId: string): V2Session {
  const proposal = session.stateProposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) throw new Error('State proposal no longer exists.');

  let next = session;
  if (proposal.kind === 'inventory-add') {
    next = operateWorld(session, {
      type: 'inventory-add',
      instanceId: crypto.randomUUID(),
      canonicalItemId: proposal.canonicalItemId,
      ownerActorId: proposal.ownerActorId,
      quantity: proposal.quantity,
      equipped: false,
    });
  } else if (proposal.kind === 'inventory-remove') {
    next = operateWorld(session, {
      type: 'inventory-remove',
      instanceId: proposal.instanceId,
    });
  } else {
    next = operateWorld(session, {
      type: 'inventory-set-equipped',
      instanceId: proposal.instanceId,
      equipped: proposal.equipped,
    });
  }

  return {
    ...next,
    stateProposals: next.stateProposals.filter((candidate) => candidate.id !== proposalId),
  };
}

export function rejectStateProposal(session: V2Session, proposalId: string): V2Session {
  return {
    ...session,
    stateProposals: session.stateProposals.filter((proposal) => proposal.id !== proposalId),
  };
}
