import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractCompletion } from '../server/providers/provider-service';
import { publicV4Package } from '../src/v4/contracts/launch';
import { V4BrowserProvider } from '../src/v4/providers/browser';
import { compileV4Context, outputContractFor, v4OutputEnvelope } from '../src/v4/runtime/context';
import { generateV4Turn } from '../src/v4/runtime/engine';
import { generateV4Output } from '../src/v4/runtime/generation';
import { generateV4PersonaDraft } from '../src/v4/runtime/persona-draft';
import { assertV4FormattingOnly, v4RoleplayFormattingIssues } from '../src/v4/runtime/output-format';
import { createV4Session, OUTPUT_PRESETS } from '../src/v4/runtime/session';
import { createRootBranch, forkBranch, generateAlternative, generationBranchTurn, projectBranch } from '../src/v4/runtime/branches';
import type { ProviderAdapter, ProviderRequest, ProviderResult } from '../src/runtime/providers/types';
import { v2Package } from './v2-fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const fresh = () => ({ ...createV4Session(publicV4Package(v2Package())), draft: '*I wait.*' });
type Draft = { text: string; completion?: unknown; abort?: () => void; http?: number };
function gateway(drafts: Draft[]) {
  const requests: Array<ProviderRequest & { launchId: string }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('/api/v4/generate');
    expect(init.credentials).toBe('same-origin');
    requests.push(JSON.parse(init.body as string));
    const next = drafts[requests.length - 1];
    if (!next) throw new Error('Unexpected extra upstream call');
    next.abort?.();
    const status = next.http ?? 200;
    return { ok: status === 200, status, text: async () => JSON.stringify({ text: next.text,
      metadata: { provider: 'orbis', model: 'test', endpoint: 'fake:gateway', durationMs: 7,
        ...extractCompletion(next.completion ?? { completionStatus: 'completed' }) } }) };
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, fetch, provider: new V4BrowserProvider('test-launch') };
}

function direct(drafts: Array<{ text: string; metadata: unknown }>) {
  let calls = 0;
  const generate = vi.fn(async (_request: ProviderRequest): Promise<ProviderResult> => {
    const next = drafts[calls++];
    if (!next) throw new Error('Unexpected extra direct provider call');
    return next as ProviderResult;
  });
  return { kind: 'mock' as const, generate } satisfies ProviderAdapter;
}
const safeMetadata = { provider: 'mock', model: 'test', endpoint: 'fake:direct', durationMs: 7, completionStatus: 'completed' };

describe('V4 independent length guidance', () => {
  it.each(Object.entries(OUTPUT_PRESETS))('%s stays independent through growing history and consecutive skips (%i ceiling)', async (preset, cap) => {
    const output = preset as keyof typeof OUTPUT_PRESETS;
    let session = fresh();
    session.settings = { ...session.settings, output, maxTokens: cap };
    const mockReplies = Array.from({ length: 9 }, (_, index) => ({ text: `*The keeper sees landmark ${index}. ${'Quiet detail. '.repeat(index * 30)}*` }));
    const { provider, requests } = gateway(mockReplies);
    const contract = outputContractFor(output, v4OutputEnvelope(cap));
    const midpoint = Math.round((contract.targetMinTokens + contract.targetMaxTokens) / 2);
    for (let index = 0; index < mockReplies.length; index += 1) {
      session = await generateV4Turn(session, provider, { skipPersona: index > 0 });
      const prompt = requests[index].prompt;
      expect(prompt).toContain(`aim near midpoint ~${midpoint} tokens, not a quota`);
      expect(prompt).toContain('NEVER previous reply length or a paragraph template');
      expect(prompt).not.toMatch(/usually \d+-\d+.*paragraph/);
      expect(prompt.length).toBeLessThanOrEqual(28000);
      expect(requests[index].maxTokens).toBe(cap);
      if (index) expect(prompt).toContain(`landmark ${index - 1}`);
    }
    expect(requests).toHaveLength(9);
    // Fake output sizes deliberately vary; this tests instructions, not provider convergence.
    expect(session.turns.at(-1)!.diagnostics.outputCompliance!.ceilingTokens).toBe(cap);
  });

  it.each([32, 64, 128, 384, 4096])('bounds every mode by a custom %i cap and switches without copying reply size', async (cap) => {
    let session = fresh();
    const { provider, requests } = gateway(Array.from({ length: 4 }, () => ({ text: '*The keeper nods.*' })));
    for (const output of ['marathon', 'short', 'long', 'normal'] as const) {
      session = await generateV4Turn({ ...session, draft: '*I look.*', settings: { ...session.settings, output, maxTokens: cap } }, provider);
      const contract = compileV4Context(session).outputContract;
      expect(contract.targetMaxTokens).toBeLessThanOrEqual(v4OutputEnvelope(cap).targetTokens);
      expect(requests.at(-1)!.maxTokens).toBe(cap);
      expect(requests.at(-1)!.prompt).toContain(`PRESET: ${output.toUpperCase()}`);
    }
  });

  it.each<[keyof typeof OUTPUT_PRESETS, number, number]>([
    ['short', 256, 60], ['normal', 512, 151], ['long', 1024, 304], ['marathon', 2048, 609],
  ])('%s truncation keeps the %i ceiling and targets literal %i tokens', async (preset, cap, target) => {
    const session = fresh();
    session.settings = { ...session.settings, output: preset as keyof typeof OUTPUT_PRESETS, maxTokens: cap };
    const { provider, requests } = gateway([{ text: '*A cut-off draft', completion: { truncated: true } }, { text: '*The keeper closes the latch.* "Stay here."' }]);
    const result = await generateV4Turn(session, provider);
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toContain(`aim for about ${target} tokens`);
    expect(requests[1].prompt).toContain('overrides ALL original length and paragraph instructions');
    expect(requests[1].prompt).not.toContain('DRAFT TO REPAIR:');
    expect(requests[1].prompt).not.toContain('A cut-off draft');
    expect(requests[1].prompt.match(/SPECULUS V4 ROLEPLAY FORMAT CONTRACT/g)).toHaveLength(1);
    expect(requests[1].maxTokens).toBe(cap);
    expect(result.turns[0].diagnostics.durationMs).toBe(14);
    expect(result.turns[0].diagnostics.warnings.join(' ')).toContain('2 upstream attempt(s)');
  });

  it.each([32, 64, 128, 384, 4096])('truncation honors custom %i hard caps and bounds the shorter target by half midpoint', async (cap) => {
    const session = fresh();
    session.settings = { ...session.settings, output: 'long', maxTokens: cap };
    const { provider, requests } = gateway([{ text: '*cut off', completion: { truncated: true } }, { text: '*The keeper nods.*' }]);
    await generateV4Turn(session, provider);
    const contract = compileV4Context(session).outputContract;
    const target = Math.max(1, Math.min(Math.floor((contract.targetMinTokens + contract.targetMaxTokens) / 4), Math.floor(cap / 2)));
    expect(requests.map((request) => request.maxTokens)).toEqual([cap, cap]);
    expect(requests[1].prompt).toContain(`aim for about ${target} tokens`);
    expect(target).toBeLessThanOrEqual((contract.targetMinTokens + contract.targetMaxTokens) / 4);
    if (cap === 32) expect(target).toBe(12);
    if (cap === 64) expect(target).toBe(24);
  });
});

describe('V4 direct adapter completion reconciliation', () => {
  it.each<[string, string]>([
    ['completed', 'timeout'], ['completed', 'cancelled'], ['completed', 'canceled'],
    ['completed', 'interrupted'], ['completed', 'error'], ['max_tokens', 'timeout'],
    ['max_tokens', 'cancelled'], ['max_tokens', 'interrupted'], ['max_tokens', 'error'],
    ['timeout', 'length'], ['cancelled', 'length'], ['bridge_interruption', 'stop'],
  ])('fatal signal wins for status %s / reason %s before any repair', async (completionStatus, finishReason) => {
    const provider = direct([{ text: '*A malformed "draft"*', metadata: { ...safeMetadata, completionStatus, finishReason } }]);
    const session = fresh();
    const original = JSON.stringify(session);
    await expect(generateV4Turn(session, provider)).rejects.toThrow('completion failed');
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(session)).toBe(original);
  });

  it.each<[string | undefined, string]>([
    ['completed', 'length'], ['completed', 'max_tokens'], ['completed', 'token_limit'],
    ['unknown', 'length'], ['max_tokens', 'stop'], [undefined, 'length'],
  ])('status %s plus reason %s regenerates once with normalized final diagnostics', async (completionStatus, finishReason) => {
    const initialMetadata = { ...safeMetadata, completionStatus, finishReason };
    const finalMetadata = { ...safeMetadata, completionStatus: undefined, finishReason: 'stop' };
    const provider = direct([
      { text: '*REJECTED_DIRECT_CUTOFF', metadata: initialMetadata },
      { text: '*The keeper nods.*', metadata: finalMetadata },
    ]);
    const next = await generateV4Turn(fresh(), provider);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(provider.generate.mock.calls[1][0].prompt).toContain('aim for about 151 tokens');
    expect(provider.generate.mock.calls[1][0].prompt).not.toContain('REJECTED_DIRECT_CUTOFF');
    expect(provider.generate.mock.calls[1][0].prompt).not.toContain('DRAFT TO REPAIR:');
    expect(next.turns[0].diagnostics.completionStatus).toBe('completed');
    expect(next.turns[0].diagnostics.finishReason).toBe('stop');
    expect(next.turns[0].diagnostics.durationMs).toBe(14);
    expect(initialMetadata.completionStatus).toBe(completionStatus);
    expect(finalMetadata.completionStatus).toBeUndefined();
  });

  it.each(['length', 'max_tokens', 'token_limit'])('second completed plus %s rejects atomically without a third call', async (finishReason) => {
    const provider = direct([
      { text: '*cut off', metadata: { ...safeMetadata, finishReason: 'length' } },
      { text: '*The keeper nods.*', metadata: { ...safeMetadata, finishReason } },
    ]);
    const session = fresh();
    const original = JSON.stringify(session);
    await expect(generateV4Turn(session, provider)).rejects.toThrow('second V4 draft');
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(session)).toBe(original);
  });

  it.each(['timeout', 'cancelled', 'interrupted', 'error'])('a second success claim cannot mask fatal reason %s', async (finishReason) => {
    const provider = direct([
      { text: '*cut off', metadata: { ...safeMetadata, finishReason: 'length' } },
      { text: '*The keeper nods.*', metadata: { ...safeMetadata, finishReason } },
    ]);
    const session = fresh();
    const original = JSON.stringify(session);
    await expect(generateV4Turn(session, provider)).rejects.toThrow('completion failed');
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(session)).toBe(original);
  });

  it('persona direct fatal reason rejects before repair without changing its fixed prefix', async () => {
    const provider = direct([{ text: '*I nod.*', metadata: { ...safeMetadata, finishReason: 'timeout' } }]);
    const session = { ...fresh(), draft: '*I wait.*' };
    await expect(generateV4PersonaDraft(session, provider)).rejects.toThrow('completion failed');
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(session.draft).toBe('*I wait.*');
  });

  it('persona direct truncation regenerates from original fixed context, never the rejected draft', async () => {
    const provider = direct([
      { text: '*REJECTED_PERSONA_CUTOFF', metadata: { ...safeMetadata, finishReason: 'length' } },
      { text: '*I wait.*\n"Hello."', metadata: safeMetadata },
    ]);
    const session = { ...fresh(), draft: '*I wait.*' };
    expect(await generateV4PersonaDraft(session, provider)).toBe('*I wait.*\n"Hello."');
    const prompt = provider.generate.mock.calls[1][0].prompt;
    expect(prompt).toContain('*I wait.*');
    expect(prompt).toContain('aim for about 151 tokens');
    expect(prompt).not.toContain('REJECTED_PERSONA_CUTOFF');
    expect(prompt).not.toContain('DRAFT TO REPAIR:');
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it.each<[unknown, string]>([
    [{ ...safeMetadata, completionStatus: undefined, finishReason: 'stop' }, 'completed'],
    [{ ...safeMetadata, completionStatus: undefined }, 'unknown'],
    [{ ...safeMetadata, completionStatus: 'unknown', finishReason: 'completed' }, 'unknown'],
    [{ ...safeMetadata, finishReason: ' STOP ' }, 'completed'],
  ])('normalizes valid direct metadata %j to %s without a retry', async (metadata, expected) => {
    const provider = direct([{ text: '*The keeper nods.*', metadata }]);
    const next = await generateV4Turn(fresh(), provider);
    expect(next.turns[0].diagnostics.completionStatus).toBe(expected);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it.each<unknown>([
    null, [], 42, 'not metadata',
    { ...safeMetadata, durationMs: NaN }, { ...safeMetadata, durationMs: Infinity },
    { ...safeMetadata, durationMs: -1 }, { ...safeMetadata, durationMs: '7' },
    { ...safeMetadata, durationMs: undefined },
    { ...safeMetadata, completionStatus: 42 }, { ...safeMetadata, completionStatus: null },
    { ...safeMetadata, completionStatus: '' }, { ...safeMetadata, completionStatus: 'invented' },
    { ...safeMetadata, finishReason: 42 }, { ...safeMetadata, finishReason: null },
    { ...safeMetadata, finishReason: '' }, { ...safeMetadata, finishReason: '   ' },
    { ...safeMetadata, model: '' }, { ...safeMetadata, model: 42 },
    { ...safeMetadata, provider: '' }, { ...safeMetadata, provider: null },
    { ...safeMetadata, endpoint: '' }, { ...safeMetadata, requestId: 42 },
    { ...safeMetadata, requestedMaxTokens: Infinity }, { ...safeMetadata, inputTokensEstimate: '100' },
  ])('rejects malformed metadata %j for both direct adapters and the actual browser adapter', async (metadata) => {
    const raw = { text: '*malformed "draft"*', metadata };
    const provider = direct([raw]);
    await expect(generateV4Turn(fresh(), provider)).rejects.toThrow(/invalid (?:completion metadata|response)/);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) }));
    vi.stubGlobal('fetch', fetch);
    await expect(generateV4Turn(fresh(), new V4BrowserProvider('test-launch'))).rejects.toThrow(/invalid (?:completion metadata|response)/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not raise a very small compiled band to a hidden minimum retry quota', async () => {
    const provider = direct([{ text: '*cut off', metadata: { ...safeMetadata, finishReason: 'length' } },
      { text: '*Done.*', metadata: safeMetadata }]);
    await generateV4Output(provider, { prompt: 'original compiled state', model: 'test', maxTokens: 32,
      temperature: 1, topK: 0, topP: 1, presencePenalty: 0, frequencyPenalty: 0, stopSequences: [], continueToEndOfSentence: true },
    { preset: 'short', ceilingTokens: 32, targetMinTokens: 1, targetMaxTokens: 3, paragraphs: '', emphasis: [] },
    { inspect: (raw) => raw });
    expect(provider.generate.mock.calls[1][0].prompt).toContain('aim for about 1 tokens');
    expect(provider.generate.mock.calls[1][0].maxTokens).toBe(32);
  });
});

describe('V4 browser + runtime single repair ownership', () => {
  it('browser is transport-only, without contract injection or hidden repair', async () => {
    const { provider, requests } = gateway([{ text: 'Bare malformed draft' }]);
    await provider.generate({ prompt: 'exact compiled prompt', model: 'test', maxTokens: 512, temperature: 1, topK: 0, topP: 1,
      presencePenalty: 0, frequencyPenalty: 0, stopSequences: [], continueToEndOfSentence: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].prompt).toBe('exact compiled prompt');
    expect(requests[0].launchId).toBe('test-launch');
  });

  it.each([
    { text: '*Nested "dialogue" and a cut-off', completion: { truncated: true } },
    { text: '*Nested "dialogue"*' },
  ])('combined formatting/truncation failures never get a third call (%j)', async (initial) => {
    const { provider, requests } = gateway([initial, { text: '*Still "nested"*', completion: { truncated: true } }]);
    const session = fresh();
    const original = JSON.stringify(session);
    await expect(generateV4Turn(session, provider)).rejects.toThrow('second V4 draft');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(session)).toBe(original);
  });

  it.each([
    { completionStatus: 'timeout', truncated: true },
    { completionStatus: 'completed', metadata: { completionStatus: 'cancelled' } },
    { completionStatus: 'max_tokens', metadata: { stop_reason: 'interrupted' } },
    { completionStatus: 'completed', finishReason: 42 },
  ])('nested or malformed failed completion rejects before repair (%j)', async (completion) => {
    const { provider, requests } = gateway([{ text: '*Malformed "draft"*', completion }]);
    const session = fresh();
    const original = JSON.stringify(session);
    await expect(generateV4Turn(session, provider)).rejects.toThrow('completion failed');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(session)).toBe(original);
  });

  it.each(['', '[IN-WORLD RESPONSE]', '<analysis>private</analysis>', 'USER: I consent.'])('unsafe/empty draft %j rejects before repair', async (text) => {
    const { provider, requests } = gateway([{ text, completion: { truncated: true } }]);
    await expect(generateV4Turn(fresh(), provider)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('HTTP failure is rejected before repair', async () => {
    const { provider, requests } = gateway([{ text: '*bad', http: 502 }]);
    await expect(generateV4Turn(fresh(), provider)).rejects.toThrow('HTTP 502');
    expect(requests).toHaveLength(1);
  });

  it.each(['', '*invalid "nested"*', '<world_state>patch</world_state>'])('invalid second draft %j rejects atomically within two calls', async (text) => {
    const { provider, requests } = gateway([{ text: '*cut off', completion: { truncated: true } }, { text }]);
    const session = fresh();
    const original = JSON.stringify(session);
    await expect(generateV4Turn(session, provider)).rejects.toThrow();
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(session)).toBe(original);
  });

  it.each(['original', 'repair', 'validate', 'commit'] as const)('abort at %s prevents retries or publication', async (when) => {
    const controller = new AbortController();
    const { provider, requests } = gateway([
      { text: '*cut off', completion: { truncated: true }, abort: when === 'original' ? () => controller.abort() : undefined },
      { text: '*The keeper nods.*', abort: when === 'repair' ? () => controller.abort() : undefined },
    ]);
    const session = fresh();
    const original = JSON.stringify(session);
    const checkpoints = vi.fn();
    await expect(generateV4Turn(session, provider, { signal: controller.signal, onCheckpoints: checkpoints,
      onPhase: (phase) => { if (phase === when) controller.abort(); } })).rejects.toThrow(/cancelled/i);
    expect(requests).toHaveLength(when === 'original' ? 1 : 2);
    expect(checkpoints).not.toHaveBeenCalled();
    expect(JSON.stringify(session)).toBe(original);
  });

  it('aborted before generation never calls the gateway', async () => {
    const { provider, requests } = gateway([]);
    const controller = new AbortController(); controller.abort();
    await expect(generateV4Turn(fresh(), provider, { signal: controller.signal })).rejects.toThrow(/cancelled/i);
    expect(requests).toHaveLength(0);
  });

  it('prose repetition remains advisory without an extra rewrite', async () => {
    const text = '*The rain falls on the roof. The rain falls on the roof. The rain falls on the roof.*';
    const { provider, requests } = gateway([{ text }]);
    const result = await generateV4Turn(fresh(), provider);
    expect(result.turns[0].reply).toBe(text);
    expect(result.turns[0].diagnostics.warnings.join(' ')).toContain('advisory only');
    expect(requests).toHaveLength(1);
  });

  it.each([{}, { completionStatus: 'unknown' }])('absent/unknown completion %j accepts safe structure without a retry', async (completion) => {
    const { provider, requests } = gateway([{ text: '*The keeper nods.*', completion }]);
    const result = await generateV4Turn(fresh(), provider);
    expect(result.turns[0].diagnostics.completionStatus).toBe('unknown');
    expect(requests).toHaveLength(1);
  });

  it.each(['skip-narrator', 'skip-npc', 'reroll', 'branch'] as const)('%s uses the same two-call owner', async (mode) => {
    const initial = gateway([{ text: '*The keeper waits.*' }]);
    const session = await generateV4Turn(fresh(), initial.provider);
    const { provider, requests } = gateway([{ text: '*cut off', completion: { truncated: true } }, { text: '*The keeper nods.*' }]);
    const options = mode === 'reroll' ? { reroll: true } : mode === 'skip-npc'
      ? { skipPersona: true, skipAsActorId: session.launch.character!.id } : { skipPersona: true };
    const result = mode === 'branch'
      ? projectBranch(await generationBranchTurn(createRootBranch(session), session.launch, provider, options), session.launch)
      : await generateV4Turn(session, provider, options);
    expect(result.turns.at(-1)!.reply).toBe('*The keeper nods.*');
    expect(requests).toHaveLength(2);
    expect(requests[1].maxTokens).toBe(session.settings.maxTokens);
  });

  it('repairs unambiguous nested speech locally without another provider call', async () => {
    const original = '*He says "Hello."* *He waits.*';
    const { provider, requests } = gateway([{ text: original }]);
    const next = await generateV4Turn(fresh(), provider);
    expect(next.turns[0].reply).toBe('*He says* "Hello." *He waits.*');
    expect(() => assertV4FormattingOnly(original, next.turns[0].reply)).not.toThrow();
    expect(next.turns[0].diagnostics.warnings.join(' ')).toContain('safe local roleplay formatting');
    expect(requests).toHaveLength(1);
  });

  it('closes a clearly complete unbalanced action locally without guessing additional text', async () => {
    const { provider, requests } = gateway([{ text: '*The keeper waits.' }]);
    const next = await generateV4Turn(fresh(), provider);
    expect(next.turns[0].reply).toBe('*The keeper waits.*');
    expect(requests).toHaveLength(1);
  });

  it('never wraps naked model instructions as action narration', async () => {
    const { provider, requests } = gateway([
      { text: 'Do not leave dangling syntax.' },
      { text: 'Do not leave dangling syntax.' },
    ]);
    await expect(generateV4Turn(fresh(), provider)).rejects.toThrow('invalid roleplay formatting');
    expect(requests).toHaveLength(2);
  });

  it.each<[string, string]>([
    ['*yes* "yes" tail', '"yes" *yes* *tail*'],
    ['a*bc* tail', '"abc" *tail*'],
    ['*He looks at "Hello."* *He waits.*', '*He looks at* "Hello." "He waits."'],
    ['Ｆｏｏ tail', '*Foo tail*'],
    ["Don't stop! tail", "*Don't stop. tail*"],
    ['*One.* tail', '*One.*'],
    ['*foobar* tail', '*foo bar* *tail*'],
    ['*foo bar* tail', '*foobar* *tail*'],
  ])('rejects format content/role laundering %j -> %j', async (text, repair) => {
    const { provider, requests } = gateway([{ text }, { text: repair }]);
    await expect(generateV4Turn(fresh(), provider)).rejects.toThrow('changed prose content or an established role');
    expect(requests).toHaveLength(2);
  });

  it('preserves multiline dialogue, punctuation, apostrophes and exact Unicode', async () => {
    const text = '*He waits.* "Don\'t change Ｆｏｏ.\nKeep this dialogue!"';
    const { provider, requests } = gateway([{ text }]);
    const next = await generateV4Turn(fresh(), provider);
    expect(v4RoleplayFormattingIssues(next.turns[0].reply)).toEqual([]);
    expect(() => assertV4FormattingOnly(text, next.turns[0].reply)).not.toThrow();
    expect(next.turns[0].reply).toContain('Ｆｏｏ');
    expect(requests).toHaveLength(1);
  });
});

describe('V4 persona and history share the owner without mutating rejected state', () => {
  it('completes an open fixed prefix naturally with no format retry', async () => {
    const session = { ...fresh(), draft: '*I step' };
    const { provider, requests } = gateway([{ text: 'into the room.* "Hello."' }]);
    expect(await generateV4PersonaDraft(session, provider)).toBe('*I step into the room.* "Hello."');
    expect(session.draft).toBe('*I step');
    expect(requests).toHaveLength(1);
  });

  it('repairs merged player structure while preserving the exact fixed prefix', async () => {
    const session = { ...fresh(), draft: '*I step' };
    const { provider, requests } = gateway([{ text: '"Hello."' }, { text: '*I step* "Hello."' }]);
    expect(await generateV4PersonaDraft(session, provider)).toBe('*I step* "Hello."');
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toContain('exact fixed operator-authored prefix unchanged');
  });

  it.each([
    { text: '*I leap* "Hello."' },
    { text: '*I step "Hello."' },
    { text: '*I step* "Hello."', completion: { truncated: true } },
    { text: '*I step* "Hello."', completion: { completionStatus: 'timeout' } },
  ])('persona repair %j rejects with prefix/completion/structure safety in at most two calls', async (repair) => {
    const session = { ...fresh(), draft: '*I step' };
    const original = JSON.stringify(session);
    const { provider, requests } = gateway([{ text: '"Hello."' }, repair]);
    await expect(generateV4PersonaDraft(session, provider)).rejects.toThrow();
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(session)).toBe(original);
  });

  it('persona truncation uses the shared shorter numeric target', async () => {
    const session = { ...fresh(), draft: '*I wait.*' };
    const { provider, requests } = gateway([{ text: '*I turn', completion: { truncated: true } }, { text: '*I wait.*\n"Hello."' }]);
    expect(await generateV4PersonaDraft(session, provider)).toBe('*I wait.*\n"Hello."');
    expect(requests[1].prompt).toContain('aim for about 151 tokens');
    expect(requests[1].prompt).not.toContain('DRAFT TO REPAIR:');
    expect(requests[1].prompt).not.toContain('*I turn');
    expect(requests).toHaveLength(2);
  });

  it.each(['unsafe', 'timeout', 'aborted', 'character'] as const)('persona %s first draft cannot be repaired or published', async (failure) => {
    const session = { ...fresh(), draft: '*I wait.*' };
    const controller = new AbortController();
    const { provider, requests } = gateway([{ text: failure === 'unsafe' ? '<analysis>hidden</analysis>' : failure === 'character' ? `*${session.launch.character!.name} waits.*` : '*I nod.*',
      completion: failure === 'timeout' ? { completionStatus: 'timeout', truncated: true } : undefined,
      abort: failure === 'aborted' ? () => controller.abort() : undefined }]);
    await expect(generateV4PersonaDraft(session, provider, { signal: controller.signal })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(session.draft).toBe('*I wait.*');
  });

  it('persona abort from validation cannot publish the composer', async () => {
    const controller = new AbortController();
    const { provider } = gateway([{ text: '*I nod.*' }]);
    await expect(generateV4PersonaDraft({ ...fresh(), draft: '' }, provider, { signal: controller.signal,
      onPhase: (phase) => { if (phase === 'validate') controller.abort(); } })).rejects.toThrow(/cancelled/i);
  });

  it('persona abort during the second attempt prevents publication without a third call', async () => {
    const controller = new AbortController();
    const session = { ...fresh(), draft: '*I wait.*' };
    const { provider, requests } = gateway([{ text: '*I turn', completion: { truncated: true } },
      { text: '*I wait.*\n"Hello."', abort: () => controller.abort() }]);
    await expect(generateV4PersonaDraft(session, provider, { signal: controller.signal })).rejects.toThrow(/cancelled/i);
    expect(requests).toHaveLength(2);
    expect(session.draft).toBe('*I wait.*');
  });

  it('failed reroll retains the complete original world, transcript and owned state', async () => {
    const initial = gateway([{ text: '*The keeper waits.*' }]);
    const session = await generateV4Turn(fresh(), initial.provider);
    const original = JSON.stringify(session);
    const { provider, requests } = gateway([{ text: '*cut off', completion: { truncated: true } }, { text: '*cut off again', completion: { truncated: true } }]);
    await expect(generateV4Turn(session, provider, { reroll: true })).rejects.toThrow();
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(session)).toBe(original);
  });

  it.each(['latest', 'historical', 'fork'] as const)('%s alternative failure retains every checkpoint, page, branch and active frontier', async (mode) => {
    const session = fresh();
    const initial = gateway([{ text: '*The keeper waits.*' }, { text: '*The keeper sees the lamp.*' }]);
    let branch = await generationBranchTurn(createRootBranch(session), session.launch, initial.provider);
    branch = await generationBranchTurn({ ...branch, draft: '*I look.*' }, session.launch, initial.provider);
    if (mode === 'fork') branch = forkBranch(branch, branch.turns[0].id, branch.turns[0].activePageId);
    const original = JSON.stringify(branch);
    const target = mode === 'historical' ? branch.turns[0] : branch.turns.at(-1)!;
    const { provider, requests } = gateway([{ text: '*cut off', completion: { truncated: true } }, { text: '*Still "nested"*' }]);
    await expect(generateAlternative(branch, session.launch, provider, target.id)).rejects.toThrow();
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(branch)).toBe(original);
    expect(projectBranch(branch, session.launch).turns).toHaveLength(branch.turns.length);
  });
});
