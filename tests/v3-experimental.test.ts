import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v3/contracts/launch';
import { compileV2Context } from '../src/v3/runtime/context';
import { generateV2Turn, stripV3ProtocolArtifacts } from '../src/v3/runtime/engine';
import { createV2Session, deleteLastTurn } from '../src/v3/runtime/session';
import { skippedPersonaActorId } from '../src/v3/runtime/turn-control';
import { MockProvider } from '../src/runtime/providers/mock';
import { getRelationship } from '../src/runtime/relationships/core';
import { exportV2Session, importV2Session } from '../src/v3/storage/session';
import type { ProviderRequest } from '../src/runtime/providers/types';
import { v2Package } from './v2-fixtures';

class ProtocolEchoProvider extends MockProvider {
  override async generate(request: ProviderRequest) {
    const result = await super.generate(request);
    return {
      ...result,
      text: [
        '[PLAYER TURN]',
        '*Old echoed player text.*',
        '[WORLD RENDER / PLAYER-VISIBLE PROSE]',
        '*The latch clicks.*',
        '[END PLAYER TURN]',
        '[IN-WORLD RESPONSE]',
        '"Come in."',
        '[END ASSISTANT TURN]',
      ].join('\n'),
    };
  }
}

describe('V3 experimental protocol isolation', () => {
  it('identifies packaged family NPCs and can advance exactly one selected NPC with Skip as', async () => {
    const launch = publicV2Package(v2Package({
      primaryAsset: { id: 'family:holt', type: 'other', revision: 'rev-1', name: 'Holt family', summary: 'The Holt household.', data: {} },
      character: null,
      initialLocationId: 'place:workshop',
      relatedAssets: [
        { id: 'place:workshop', type: 'place', revision: 'rev-1', name: 'Workshop', summary: 'A quiet workshop.', data: {} },
        { id: 'character:ragna', type: 'character', revision: 'rev-1', name: 'Ragna Holt', summary: 'Mother of the Holt family.', data: { role: 'mother' } },
        { id: 'character:pip', type: 'character', revision: 'rev-1', name: 'Pip Holt', summary: 'Daughter in the Holt family.', data: { role: 'daughter' } },
      ],
    }));
    const value = createV2Session(launch);
    expect(value.world.actors.filter((actor) => actor.role === 'character').map((actor) => actor.name)).toEqual(['Ragna Holt', 'Pip Holt']);

    class RagnaProvider extends MockProvider {
      override async generate(request: ProviderRequest) {
        const result = await super.generate(request);
        return { ...result, text: '*Ragna rests one hand on the table.* "Tell me what happened."' };
      }
    }

    const next = await generateV2Turn(value, new RagnaProvider(), { skipAsActorId: 'character:ragna' });
    const turn = next.turns.at(-1)!;
    expect(skippedPersonaActorId(turn.player)).toBe('character:ragna');
    expect(turn.diagnostics.prompt).toContain('selected Ragna Holt as the next acting NPC');
    expect(turn.diagnostics.prompt).toContain('Write only Ragna Holt\'s next immediate meaningful beat');
    expect(turn.diagnostics.prompt).toContain('do not complete a full back-and-forth exchange');
    expect(turn.diagnostics.subjectActorId).toBe('character:ragna');
    expect(next.draft).toBe('');
  });

  it('sanitizes legacy protocol echoes before committing a visible reply', async () => {
    const value = { ...createV2Session(publicV2Package(v2Package())), draft: '*I look around.*' };
    const next = await generateV2Turn(value, new ProtocolEchoProvider());

    expect(next.turns.at(-1)?.reply).toBe('*The latch clicks.*\n\n"Come in."');
    expect(next.turns.at(-1)?.id.startsWith('v3:')).toBe(true);
    expect(next.turns.at(-1)?.diagnostics.warnings.join(' ')).toContain('Legacy Speculus turn/control markers were stripped');
  });

  it('keeps legacy turn-boundary markers out of compiled V3 history and response boundaries', async () => {
    const value = { ...createV2Session(publicV2Package(v2Package())), draft: '*I look around.*' };
    const next = await generateV2Turn(value, new ProtocolEchoProvider());
    next.draft = '*I wait.*';
    const packet = compileV2Context(next, next.draft);

    expect(packet.prompt.startsWith('SPECULUS V3 EXPERIMENTAL /')).toBe(true);
    expect(packet.prompt).toContain('[IN-WORLD RESPONSE]');
    expect(packet.prompt).toContain('Recent exchange (context only, not engine authority)');
    expect(packet.prompt).not.toContain('[PLAYER TURN]');
    expect(packet.prompt).not.toContain('[END PLAYER TURN]');
    
    expect(packet.prompt).not.toContain('[WORLD RENDER / PLAYER-VISIBLE PROSE]');
    expect(packet.prompt).not.toContain('[END RECENT EXCHANGE]');
  });

  it('tiers older committed turns into chronicle and archive context without exceeding the V3 budget', async () => {
    let value = createV2Session(publicV2Package(v2Package()));
    const provider = new MockProvider();

    for (let index = 1; index <= 20; index += 1) {
      value = { ...value, draft: `*I perform test action ${index} and remember marker-${index}.*` };
      value = await generateV2Turn(value, provider, { now: 1_800_000_000_000 + index });
    }

    value.draft = '*I continue.*';
    const packet = compileV2Context(value, value.draft);
    const recentCount = packet.prompt.match(/Recent exchange \(context only, not engine authority\)/g)?.length ?? 0;

    expect(recentCount).toBe(4);
    expect(packet.prompt).toContain('SESSION CHRONICLE / DERIVED FROM COMMITTED TURN');
    expect(packet.prompt).toContain('SESSION ARCHIVE RECAP / LOW-PRIORITY DERIVED MEMORY');
    expect(packet.prompt).toContain('marker-20');
    expect(packet.prompt).toContain('marker-1');
    expect(packet.estimatedInputTokens).toBeLessThanOrEqual(7000);
  });

  it('evolves explicit relationship cues without double-counting rerolls and persists them in raw saves', async () => {
    let value = createV2Session(publicV2Package(v2Package()));
    const provider = new MockProvider();
    value.draft = '"Thank you. I trust you."';

    value = await generateV2Turn(value, provider, { now: 1_800_000_100_000 });
    const characterId = value.launch.character!.id;
    const personaId = value.launch.persona.id;
    const turnId = value.turns.at(-1)!.id;
    const first = getRelationship(value.relationships, characterId, personaId);

    expect(first.score).toBe(10);
    expect(first.dimensions.trust).toBe(4);
    expect(first.dimensions.affection).toBe(2);
    expect(first.events.filter((event) => event.turnId === turnId)).toHaveLength(1);

    const packet = compileV2Context(value, '*I wait.*');
    expect(packet.prompt).toContain('ORBIS / SESSION RELATIONSHIP STATE');
    expect(packet.prompt).toContain('"score":10');

    value = await generateV2Turn(value, provider, { reroll: true, now: 1_800_000_100_100 });
    const rerolled = getRelationship(value.relationships, characterId, personaId);
    expect(rerolled.score).toBe(10);
    expect(rerolled.events.filter((event) => event.turnId === turnId)).toHaveLength(1);

    const raw = exportV2Session(value, 1_800_000_100_200);
    const fresh = createV2Session(publicV2Package(v2Package({ launchId: 'fresh-v3-relationship-launch' })));
    const restored = importV2Session(raw, fresh);
    expect(getRelationship(restored.relationships, characterId, personaId).score).toBe(10);

    const deleted = deleteLastTurn(value);
    const afterDelete = getRelationship(deleted.relationships, characterId, personaId);
    expect(afterDelete.score).toBe(0);
    expect(afterDelete.events.filter((event) => event.turnId === turnId)).toHaveLength(0);
  });

  it('keeps unrevealed mystery state out of player-visible context', () => {
    const value = createV2Session(publicV2Package(v2Package()));
    value.world.domains.mysteries = [
      {
        id: 'mystery-state-hidden',
        mysteryId: 'secret:hidden-truth',
        stageIndex: 0,
        knownByActorIds: [],
        revealedFactIds: [],
      },
      {
        id: 'mystery-state-known',
        mysteryId: 'secret:known-thread',
        stageIndex: 2,
        knownByActorIds: [value.launch.persona.id],
        revealedFactIds: ['fact:known-clue'],
      },
    ];

    const packet = compileV2Context(value, '*I inspect the room.*');

    expect(packet.prompt).not.toContain('secret:hidden-truth');
    expect(packet.prompt).toContain('secret:known-thread');
    expect(packet.prompt).toContain('fact:known-clue');
    expect(packet.prompt).toContain('NEVER EXPAND BEYOND REVEALED FACTS');
  });

  it('can strip a legacy provider response independently', () => {
    const raw = [
      '[PLAYER TURN]',
      '*Old echoed player text.*',
      '[WORLD RENDER / PLAYER-VISIBLE PROSE]',
      '*The latch clicks.*',
      '[END PLAYER TURN]',
      '[IN-WORLD RESPONSE]',
      '"Come in."',
      '[END ASSISTANT TURN]',
    ].join('\n');

    expect(stripV3ProtocolArtifacts(raw)).toBe('*The latch clicks.*\n\n"Come in."');
  });
});
