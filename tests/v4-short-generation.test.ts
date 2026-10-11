import { describe, expect, it } from 'vitest';
import { publicV4Package } from '../src/v4/contracts/launch';
import { compileV4Context, v4ProviderOutputBudget } from '../src/v4/runtime/context';
import { generateV4Turn } from '../src/v4/runtime/engine';
import { createV4Session, OUTPUT_PRESETS } from '../src/v4/runtime/session';
import type { ProviderAdapter, ProviderRequest, ProviderResult } from '../src/runtime/providers/types';
import { v2Package } from './v2-fixtures';

function session(maxTokens: number = OUTPUT_PRESETS.short) {
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
  it('keeps completion headroom inside the approved 256-token short ceiling', () => {
    const compiled = compileV4Context(session(), 'I wait.');
    expect(compiled.outputBudget).toBe(256);
    expect(compiled.outputContract).toMatchObject({
      preset: 'short',
      ceilingTokens: 256,
      targetMinTokens: 80,
      targetMaxTokens: 160,
    });
    expect(compiled.prompt).toContain('PRESET: SHORT. Independent soft band 80-160 tokens; aim near midpoint ~120 tokens, not a quota. Hard ceiling 256 tokens.');
    expect(compiled.prompt).toContain('Finish one natural complete playable beat');
    expect(compiled.prompt).toContain('Close all quotes/actions/brackets before stopping.');
  });

  it('honors advanced custom token limits and backs off guidance within the actual limit', () => {
    const custom = compileV4Context(session(128), 'I wait.');
    expect(custom.outputBudget).toBe(128);
    expect(custom.outputContract.ceilingTokens).toBe(128);
    expect(custom.outputContract.targetMaxTokens).toBe(96);

    const baseline = session();
    const normalSession = { ...baseline, settings: { ...baseline.settings, output: 'normal' as const, maxTokens: OUTPUT_PRESETS.normal } };
    const normal = compileV4Context(normalSession, 'I wait.');
    expect(normal.outputBudget).toBe(OUTPUT_PRESETS.normal);
  });

  it.each(Object.entries(OUTPUT_PRESETS))('keeps the exact %s provider ceiling at %i', (output, maxTokens) => {
    const baseline = session();
    const settings = { ...baseline.settings, output: output as typeof baseline.settings.output, maxTokens };
    expect(v4ProviderOutputBudget(settings)).toBe(maxTokens);
    expect(compileV4Context({ ...baseline, settings }, 'I wait.').outputBudget).toBe(maxTokens);
  });

  it('sends the selected short budget without lengthening a completed reply', async () => {
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
    expect(requests[0].maxTokens).toBe(256);
    expect(result.turns.at(-1)?.reply).toContain('You may enter.');
    expect(result.turns.at(-1)?.diagnostics.outputCompliance?.preset).toBe('short');
    expect(result.turns.at(-1)?.diagnostics.outputBudget).toBe(256);
  });

  it('regenerates a shorter fresh beat at the same ceiling after truncation', async () => {
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
    expect(requests.map((request) => request.maxTokens)).toEqual([256, 256]);
    expect(requests[1].prompt).toContain('REPAIR OVERRIDE / ONE REMAINING ATTEMPT');
    expect(requests[1].prompt).toContain('aim for about 60 tokens, not a quota');
    expect(requests[1].prompt).toContain('Do not continue the cut-off text');
    expect(requests[1].prompt).not.toContain('*She opens the');
    expect(result.turns.at(-1)?.reply).toContain('opens the door');
    expect(result.turns.at(-1)?.diagnostics.warnings.join(' ')).toContain('hard-ceiling truncation');
  });

  it('retains overlong completed prose with advisory diagnostics and no automatic rewrite', async () => {
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
    expect(requests).toHaveLength(1);
    expect(requests[0].maxTokens).toBe(256);
    expect(result.turns.at(-1)?.reply.replace(/\*/g, '').replace(/\s+/g, ' ').trim()).toBe(overlong.replace(/\*/g, ''));
    expect(result.turns.at(-1)?.diagnostics.outputCompliance?.band).toBe('over-target');
    expect(result.turns.at(-1)?.diagnostics.warnings.join(' ')).toContain('no length rewrite was attempted');
    expect(result.turns.at(-1)?.diagnostics.warnings.join(' ')).toContain('no style rewrite was attempted');
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
    await expect(generateV4Turn(original, provider)).rejects.toThrow('second V4 draft reached the hard output ceiling');
    expect(calls).toBe(2);
    expect(JSON.stringify(original)).toBe(originalSnapshot);
  });
});
