import { describe, expect, it } from 'vitest';
import { publicV4Package } from '../src/v4/contracts/launch';
import { compileV4Context } from '../src/v4/runtime/context';
import { generateV4Turn, V4DraftRejected } from '../src/v4/runtime/engine';
import { createV4Session, OUTPUT_PRESETS } from '../src/v4/runtime/session';
import type { ProviderAdapter, ProviderRequest, ProviderResult } from '../src/runtime/providers/types';
import { v2Package } from './v2-fixtures';

function session(maxTokens = OUTPUT_PRESETS.short) {
  const base = createV4Session(publicV4Package(v2Package()));
  return {
    ...base,
    draft: '*I look toward the open door.*',
    settings: { ...base.settings, output: 'short' as const, maxTokens },
  };
}

function reply(request: ProviderRequest, text: string, completionStatus: 'completed' | 'max_tokens'): ProviderResult {
  return {
    text,
    metadata: {
      provider: 'mock',
      model: request.model,
      endpoint: 'test',
      durationMs: 2,
      completionStatus,
      requestedMaxTokens: request.maxTokens,
    },
  };
}

describe('V4 short generation completion headroom', () => {
  it('preserves the 80–160 token writing target but gives saved short defaults 768 provider tokens', () => {
    const compiled = compileV4Context(session(), 'I wait.');
    expect(compiled.outputBudget).toBe(768);
    expect(compiled.outputContract).toMatchObject({
      preset: 'short',
      ceilingTokens: 768,
      targetMinTokens: 80,
      targetMaxTokens: 160,
    });
    expect(compiled.prompt).toContain('PRESET: SHORT. Target ~160 tokens, hard ceiling 768 tokens.');
  });

  it('honors advanced custom token limits and does not alter the normal preset', () => {
    const custom = compileV4Context(session(128), 'I wait.');
    expect(custom.outputBudget).toBe(128);
    expect(custom.outputContract.ceilingTokens).toBe(128);

    const normalSession = session();
    normalSession.settings = { ...normalSession.settings, output: 'normal', maxTokens: OUTPUT_PRESETS.normal };
    const normal = compileV4Context(normalSession, 'I wait.');
    expect(normal.outputBudget).toBe(OUTPUT_PRESETS.normal);
  });

  it('sends the expanded short budget to the actual provider without lengthening a completed reply', async () => {
    const requests: ProviderRequest[] = [];
    const provider: ProviderAdapter = {
      kind: 'mock',
      async generate(request) {
        requests.push(request);
        return reply(request, '*She nods once.* "You may enter."', 'completed');
      },
    };
    const result = await generateV4Turn(session(), provider);
    expect(requests).toHaveLength(1);
    expect(requests[0].maxTokens).toBe(768);
    expect(result.turns.at(-1)?.reply).toContain('You may enter.');
    expect(result.turns.at(-1)?.diagnostics.outputCompliance?.preset).toBe('short');
    expect(result.turns.at(-1)?.diagnostics.outputBudget).toBe(768);
  });

  it('gives the one existing bounded repair additional room if the initial short draft still truncates', async () => {
    const requests: ProviderRequest[] = [];
    const provider: ProviderAdapter = {
      kind: 'mock',
      async generate(request) {
        requests.push(request);
        return requests.length === 1
          ? reply(request, '*She opens the', 'max_tokens')
          : reply(request, '*She opens the door and waits.*', 'completed');
      },
    };
    const result = await generateV4Turn(session(), provider);
    expect(requests.map((request) => request.maxTokens)).toEqual([768, 1536]);
    expect(requests[1].prompt).toContain('[ONE BOUNDED PROSE REPAIR]');
    expect(result.turns.at(-1)?.reply).toContain('opens the door');
    expect(result.turns.at(-1)?.diagnostics.warnings.join(' ')).toContain('hard-ceiling truncation');
  });

  it('reduces an overlong completed short draft with only one additional call', async () => {
    const requests: ProviderRequest[] = [];
    const overlong = `*${Array.from({ length: 90 }, (_, i) => `Stone ${i} shifts near the path.`).join(' ')}*`;
    const provider: ProviderAdapter = {
      kind: 'mock',
      async generate(request) {
        requests.push(request);
        return reply(request, requests.length === 1 ? overlong : '*She points toward the path.* "There."', 'completed');
      },
    };
    const result = await generateV4Turn(session(), provider);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.maxTokens)).toEqual([768, 768]);
    expect(requests[1].prompt).toContain('exceeded the SHORT preset');
    expect(result.turns.at(-1)?.reply).toContain('She points toward the path.');
  });

  it('still rejects an incomplete second draft instead of committing cut-off prose', async () => {
    const original = session();
    const originalSnapshot = JSON.stringify(original);
    let calls = 0;
    const provider: ProviderAdapter = {
      kind: 'mock',
      async generate(request) {
        calls += 1;
        return reply(request, '*A sentence that never', 'max_tokens');
      },
    };
    await expect(generateV4Turn(original, provider)).rejects.toBeInstanceOf(V4DraftRejected);
    expect(calls).toBe(2);
    expect(JSON.stringify(original)).toBe(originalSnapshot);
  });
});
