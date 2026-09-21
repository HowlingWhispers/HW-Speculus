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
