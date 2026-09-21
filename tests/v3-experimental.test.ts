import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v3/contracts/launch';
import { compileV2Context } from '../src/v3/runtime/context';
import { generateV2Turn, stripV3ProtocolArtifacts } from '../src/v3/runtime/engine';
import { createV2Session } from '../src/v3/runtime/session';
import { MockProvider } from '../src/runtime/providers/mock';
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

    expect(packet.prompt).toContain('SPECULUS V3 EXPERIMENTAL');
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
