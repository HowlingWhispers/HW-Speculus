import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v3/contracts/launch';
import { compileV2Context, outputContractFor, v2OutputEnvelope } from '../src/v3/runtime/context';
import { createV2Session, settingsSchema, OUTPUT_PRESETS } from '../src/v3/runtime/session';
import { generateV2Turn, normalizeV2RoleplayFormat } from '../src/v3/runtime/engine';
import { normalizeV2Paragraphs, countV2Paragraphs } from '../src/v3/runtime/paragraphs';
import { detectV3ProseSlop, needsV3ProseRepair } from '../src/v3/runtime/prose-quality';
import { MockProvider } from '../src/runtime/providers/mock';
import type { ProviderRequest } from '../src/runtime/providers/types';
import { v2Package } from './v2-fixtures';

function launch() {
  return publicV2Package(v2Package({
    primaryAsset: { id: 'world:bitterroot', type: 'world', revision: 'rev-1', name: 'Bitterroot', summary: 'A world.', data: {} },
    character: null,
    initialLocationId: 'place:hollowmere',
    relatedAssets: [{ id: 'place:hollowmere', type: 'place', revision: 'rev-1', name: 'Hollowmere', summary: 'A town.', data: {} }],
  } as never));
}

function withPreset(preset: 'short' | 'normal' | 'long' | 'marathon') {
  const session = createV2Session(launch());
  return { ...session, settings: settingsSchema.parse({ ...session.settings, output: preset, maxTokens: OUTPUT_PRESETS[preset] }) };
}

const words = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('V3 output preset contract', () => {
  it('SHORT explicitly requests 1-2 short paragraphs', () => {
    const compiled = compileV2Context(withPreset('short'), 'go', 'normal');
    expect(compiled.outputContract.preset).toBe('short');
    expect(compiled.outputContract.paragraphs).toContain('1-2 short paragraphs');
    expect(compiled.prompt).toContain('PRESET: SHORT.');
    expect(compiled.prompt).toContain('usually 1-2 short paragraphs');
    expect(compiled.prompt).toContain('No recap, no scene expansion, no extra conversational exchange.');
  });

  it('MARATHON explicitly requests substantially greater depth, expanding depth not time', () => {
    const compiled = compileV2Context(withPreset('marathon'), 'go', 'normal');
    expect(compiled.outputContract.preset).toBe('marathon');
    expect(compiled.prompt).toContain('PRESET: MARATHON.');
    expect(compiled.prompt).toContain('Expand DEPTH, not TIME');
    expect(compiled.prompt).toContain('richer sensory and environmental detail');
    expect(compiled.prompt).toContain('Never simulate the next ten minutes of play without the player.');
    const marathon = compiled.outputContract;
    const short = outputContractFor('short', v2OutputEnvelope(OUTPUT_PRESETS.short));
    expect(marathon.targetMaxTokens).toBeGreaterThan(short.targetMaxTokens * 3);
  });

  it('all four presets produce different target envelopes and ceilings', () => {
    const presets = ['short', 'normal', 'long', 'marathon'] as const;
    const envelopes = presets.map((preset) => outputContractFor(preset, v2OutputEnvelope(OUTPUT_PRESETS[preset])));
    const ranges = envelopes.map((entry) => `${entry.targetMinTokens}-${entry.targetMaxTokens}`);
    expect(new Set(ranges).size).toBe(4);
    expect(new Set(envelopes.map((entry) => entry.ceilingTokens)).size).toBe(4);
    // strictly increasing depth
    for (let i = 1; i < envelopes.length; i += 1) {
      expect(envelopes[i].targetMaxTokens).toBeGreaterThan(envelopes[i - 1].targetMaxTokens);
      expect(envelopes[i].targetMinTokens).toBeGreaterThan(envelopes[i - 1].targetMinTokens);
    }
    // and the preset name reaches the prompt, not only the number
    for (const preset of presets) {
      const compiled = compileV2Context(withPreset(preset), 'go', 'normal');
      expect(compiled.prompt).toContain(`PRESET: ${preset.toUpperCase()}.`);
      expect(compiled.prompt).toContain('OUTPUT PRESET CONTRACT / TARGET SHAPE AND HARD CEILING');
    }
  });

  it('carries the readability contract into the renderer prompt', () => {
    const compiled = compileV2Context(withPreset('normal'), 'go', 'normal');
    expect(compiled.prompt).toContain('Use short paragraphs.');
    expect(compiled.prompt).toContain('No headings, bullet lists, speaker labels, or out-of-character formatting.');
    expect(compiled.prompt).toContain('Target ~');
    expect(compiled.prompt).toContain('Avoid stock voice textures');
  });

  it('never advertises a target above a custom hard budget', () => {
    const value = withPreset('marathon');
    value.settings = settingsSchema.parse({ ...value.settings, maxTokens: 128 });
    const compiled = compileV2Context(value, 'go', 'normal');
    expect(compiled.outputContract.targetMaxTokens).toBeLessThan(128);
    expect(compiled.outputContract.targetMinTokens).toBeLessThanOrEqual(compiled.outputContract.targetMaxTokens);
    expect(compiled.prompt).toContain('Target ~96 tokens, hard ceiling 128 tokens.');
  });
});

describe('V3 prose specificity guard', () => {
  it('requires multiple high-confidence constructions before spending a repair call', () => {
    const one = detectV3ProseSlop('*It was not fear, it was caution.*');
    const two = detectV3ProseSlop('*It was not fear, it was caution, her gaze a narrow warning.*');
    expect(needsV3ProseRepair(one)).toBe(false);
    expect(needsV3ProseRepair(two)).toBe(true);
  });

  it('repairs one truncated draft within the same hard ceiling', async () => {
    const session = { ...withPreset('normal'), draft: 'I wait beside the door.' };
    const requests: ProviderRequest[] = [];
    const provider = {
      kind: 'mock' as const,
      async generate(request: ProviderRequest) {
        requests.push(request);
        return requests.length === 1
          ? { text: '*She reaches for the', metadata: { provider: 'mock' as const, model: request.model, endpoint: 'mock', durationMs: 2, completionStatus: 'max_tokens' as const } }
          : { text: '*She stops beside the door and listens.*', metadata: { provider: 'mock' as const, model: request.model, endpoint: 'mock', durationMs: 3, completionStatus: 'completed' as const } };
      },
    };
    const next = await generateV2Turn(session, provider);
    expect(requests).toHaveLength(2);
    expect(requests[1].maxTokens).toBe(OUTPUT_PRESETS.normal);
    expect(requests[1].prompt).toContain('[ONE BOUNDED PROSE REPAIR]');
    expect(next.turns.at(-1)?.reply).toContain('stops beside the door');
    expect(next.turns.at(-1)?.diagnostics.warnings.join(' ')).toContain('hard-ceiling truncation');
  });
});

describe('V3 deterministic paragraph safety', () => {
  const giant = `*Ragna's ears angle toward the sound from the tree line and hold there, fixed on the dark between the trunks, while her hand settles slowly against the hilt at her side without drawing it.* ${'She does not advance, and the waiting stretches out long enough that the insects go quiet in the undergrowth one by one. '.repeat(30)}"That wasn't the wind." *She glances toward you, waiting rather than marching ahead on her own, and the lantern light catches the edge of her jaw as the silence holds.*`;

  it('gives giant safe prose blocks readable paragraph breaks', () => {
    const result = normalizeV2Paragraphs(giant);
    expect(result.applied).toBe(true);
    expect(result.text.length).toBeGreaterThan(giant.length); // only newlines added
    expect(result.paragraphs).toBeGreaterThan(2);
  });

  it('preserves existing paragraph breaks and leaves readable text untouched', () => {
    const readable = `*A short beat happens in the hall.*\n\n"That is enough for now."\n\n*She turns away.*`;
    const result = normalizeV2Paragraphs(readable);
    expect(result.text).toBe(readable);
    expect(result.applied).toBe(false);
    expect(result.paragraphs).toBe(3);
  });

  it('never splits inside quoted dialogue', () => {
    const longDialogue = `"${'and then she said something that went on and on for a while without pausing. '.repeat(40)}"`;
    const result = normalizeV2Paragraphs(`*She begins.* ${longDialogue} *She stops.*`);
    // every quoted region must survive intact inside a single paragraph
    const quotes = result.text.match(/"[^"]*"/g) ?? [];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toBe(longDialogue);
  });

  it('never splits inside *action markup*', () => {
    const longAction = `*${'the lantern swings and the shadows lean across the wall and the cold comes in under the door. '.repeat(40)}*`;
    const result = normalizeV2Paragraphs(`${longAction} "Understood."`);
    const actions = result.text.match(/\*[^*]*\*/g) ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toBe(longAction);
  });

  it('never splits inside bracketed inner voice', () => {
    const longVoice = `[${'this is not the wind at all and something in the dark is paying very close attention. '.repeat(40)}]`;
    const result = normalizeV2Paragraphs(`*He listens.* ${longVoice} *He waits.*`);
    const voices = result.text.match(/\[[^\]]*\]/g) ?? [];
    expect(voices).toHaveLength(1);
    expect(voices[0]).toBe(longVoice);
  });

  it('never changes the actual words', () => {
    const source = `*Ragna's ears angle toward the sound.* ${'The undergrowth holds its breath. '.repeat(40)}"That wasn't the wind." *She waits.*`;
    const before = words(source);
    const roleplay = normalizeV2RoleplayFormat(source);
    const result = normalizeV2Paragraphs(roleplay);
    expect(words(result.text)).toBe(words(roleplay));
    // word multiset is identical
    expect(result.text.split(/\s+/).filter(Boolean).sort()).toEqual(roleplay.split(/\s+/).filter(Boolean).sort());
  });

  it('does not create one-sentence spam when structure is already readable', () => {
    const source = Array.from({ length: 6 }, (_, i) => `*Beat ${i} unfolds quietly.*`).join('\n\n');
    const result = normalizeV2Paragraphs(source);
    expect(result.paragraphs).toBe(6);
    expect(result.applied).toBe(false);
  });

  it('paragraph formatting does not alter authoritative world state', async () => {
    const session = { ...withPreset('normal'), draft: 'I step closer to the fire.' };
    const giantReply = `*Ragna watches the fire.* ${'The heat shifts the air between us. '.repeat(60)}"Stay there." *She does not move.*`;
    const shortReply = '*Ragna watches the fire.* "Stay there." *She does not move.*';
    const provider = (text: string) => ({
      kind: 'mock' as const,
      async generate(request: ProviderRequest) {
        const result = await new MockProvider().generate(request);
        return { ...result, text };
      },
    });
    const next = await generateV2Turn(session, provider(giantReply), {});
    const control = await generateV2Turn(session, provider(shortReply), {});

    // committed reply was made readable
    expect(countV2Paragraphs(next.turns.at(-1)!.reply)).toBeGreaterThan(1);
    expect(countV2Paragraphs(control.turns.at(-1)!.reply)).toBe(1);

    // Identical authoritative state to a control run whose prose was short
    // enough to need no paragraph repair. Formatting is presentation only.
    expect(next.world.elapsedSeconds).toBe(control.world.elapsedSeconds);
    expect(next.world.simulationDay).toBe(control.world.simulationDay);
    expect(next.world.locationId).toBe(control.world.locationId);
    expect(next.world.revision).toBe(control.world.revision);
    expect(next.world.actors).toEqual(control.world.actors);
    expect(next.turns).toHaveLength(1);
    expect(next.draft).toBe(control.draft);
  });
});
