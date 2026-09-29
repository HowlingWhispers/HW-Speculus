import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2BrowserProvider, v3RoleplayFormattingIssues } from '../src/v3/providers/browser';

const request = {
  prompt: 'Render the current scene.', model: 'xialong-v1', temperature: 0.85, maxTokens: 512,
  topK: 250, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0,
  stopSequences: [], continueToEndOfSentence: true,
};

function gatewayResponse(text: string, durationMs = 5) {
  return new Response(JSON.stringify({
    text,
    metadata: {
      provider: 'orbis',
      model: 'xialong-v1',
      endpoint: 'test://orbis',
      durationMs,
      completionStatus: 'completed',
      finishReason: 'test_complete',
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('V3 roleplay formatting guard', () => {
  it('detects bare prose that makes dialogue and action styling ambiguous', () => {
    const malformed = '*The pony raised an eyebrow.* That is a good point. *He tapped a hoof.* So, are you here for the show?';
    expect(v3RoleplayFormattingIssues(malformed)).toContain('bare prose outside roleplay delimiters');
  });

  it('adds the strict format contract and repairs a malformed completion without changing prose content', async () => {
    const malformed = '*The pony raised an eyebrow.* That is a good point. *He tapped a hoof.* So, are you here for the show?';
    const repaired = '*The pony raised an eyebrow.* "That is a good point." *He tapped a hoof.* "So, are you here for the show?"';
    const upstream = vi.fn()
      .mockResolvedValueOnce(gatewayResponse(malformed, 5))
      .mockResolvedValueOnce(gatewayResponse(repaired, 3));
    vi.stubGlobal('fetch', upstream);

    const result = await new V2BrowserProvider('launch-fixture').generate(request);

    expect(result.text).toBe(repaired);
    expect(result.metadata.durationMs).toBe(8);
    expect(upstream).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(upstream.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(upstream.mock.calls[1][1]?.body));
    expect(firstBody.prompt).toContain('Correct pattern:');
    expect(firstBody.prompt).toContain('Never put spoken dialogue inside asterisks');
    expect(secondBody.prompt).toContain('FORMAT REPAIR ONLY');
  });

  it('does not spend a repair generation on already valid roleplay formatting', async () => {
    const valid = '*The pony raises an eyebrow.* "That is a good point."';
    const upstream = vi.fn(async () => gatewayResponse(valid));
    vi.stubGlobal('fetch', upstream);

    const result = await new V2BrowserProvider('launch-fixture').generate(request);

    expect(result.text).toBe(valid);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('discards a repair attempt if the provider rewrites the prose instead of only fixing delimiters', async () => {
    const malformed = '*The pony raised an eyebrow.* That is a good point.';
    const rewritten = '*The stallion grinned.* "Absolutely."';
    const upstream = vi.fn()
      .mockResolvedValueOnce(gatewayResponse(malformed))
      .mockResolvedValueOnce(gatewayResponse(rewritten));
    vi.stubGlobal('fetch', upstream);

    await expect(new V2BrowserProvider('launch-fixture').generate(request))
      .rejects.toThrow('formatting repair changed prose content');
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
