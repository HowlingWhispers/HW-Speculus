import { describe, expect, it, vi } from 'vitest';
import { publicV2Package } from '../src/v2/contracts/launch';
import type { ProviderAdapter, ProviderRequest } from '../src/runtime/providers/types';
import { createV2Session, deleteLastTurn, operateWorld, OUTPUT_PRESETS } from '../src/v2/runtime/session';
import { compileV2Context, CONTEXT_CHARACTER_BUDGET } from '../src/v2/runtime/context';
import { generateV2Turn, V2DraftRejected, validateV2Reply } from '../src/v2/runtime/engine';
import { resolveV2PlayerTurn } from '../src/v2/runtime/resolution';
import { perceptionFor } from '../src/v2/runtime/world';
import { exportV2Session, importV2Session } from '../src/v2/storage/session';
import { v2Package } from './v2-fixtures';

const session = () => ({ ...createV2Session(publicV2Package(v2Package())), draft: '*I look around.*' });
const adapter = (text = '*Peony looks up.* "Hello."', status: 'completed' | 'max_tokens' = 'completed') => ({ kind: 'mock', generate: vi.fn(async () => ({ text, metadata: { provider: 'mock' as const, model: 'xialong-v1', endpoint: 'mock', durationMs: 1, completionStatus: status } })) }) satisfies ProviderAdapter;

describe('isolated V2 world and cognition', () => {
  it('does not invent a place, time of day or character presence', () => {
    const value = session();
    expect(value.world.locationId).toBeNull(); expect(value.world.elapsedSeconds).toBe(0);
    expect(perceptionFor(value.world, value.launch.character!.id).presentActors).toEqual([]);
  });
  it('accepts only canonical scene anchors and existing actors, without mutating its input', () => {
    const value = session();
    expect(() => operateWorld(value, { type: 'set-scene', locationId: 'invented', presentActorIds: [value.launch.persona.id] })).toThrow('canonical');
    expect(() => operateWorld(value, { type: 'set-scene', locationId: 'place:workshop', presentActorIds: ['intruder'] })).toThrow('packaged actors');
    const anchored = operateWorld(value, { type: 'set-scene', locationId: 'place:workshop', presentActorIds: value.world.actors.map((actor) => actor.id) });
    expect(value.world.revision).toBe(0); expect(anchored.world.revision).toBe(1);
    expect(perceptionFor(anchored.world, value.launch.character!.id).presentActors).toHaveLength(2);
  });
  it('keeps knowledge actor-local and records deterministic clock changes', () => {
    const value = session();
    const learned = operateWorld(value, { type: 'record-knowledge', actorId: value.launch.character!.id, fact: 'The lamp is broken.' });
    expect(perceptionFor(learned.world, value.launch.persona.id).knownFacts).toEqual([]);
    expect(perceptionFor(learned.world, value.launch.character!.id).knownFacts).toEqual(['The lamp is broken.']);
    expect(operateWorld(learned, { type: 'advance-clock', seconds: 60 }).world.elapsedSeconds).toBe(60);
    for (const seconds of [-1, 0, 0.5, Infinity, 86401]) expect(() => operateWorld(learned, { type: 'advance-clock', seconds })).toThrow();
  });
  it('creates a player-perspective resolution packet without trusting prose as state', () => {
    const value = session();
    const before = structuredClone(value.world);
    const resolved = resolveV2PlayerTurn(value);
    expect(resolved.session.world).toEqual(before);
    expect(resolved.resolution.status).toBe('deferred');
    expect(resolved.resolution.playerActorId).toBe(value.launch.persona.id);
    expect(resolved.resolution.subjectActorId).toBe(value.launch.character!.id);
    expect(resolved.resolution.worldRevisionBefore).toBe(value.world.revision);
    expect(resolved.resolution.worldRevisionAfter).toBe(value.world.revision);
    expect(resolved.resolution.appliedActions).toEqual([]);
    expect(resolved.resolution.deferredClaims.join(' ')).toContain('not converted into authoritative movement');
  });
});

describe('V2 generation transaction', () => {
  it('forwards every native setting, resolves before rendering, commits one stable event, and leaves unsupported prose out of world state', async () => {
    const value = session(); const provider = adapter(); const phases: string[] = [];
    value.settings = { ...value.settings, maxTokens: 1024, temperature: 0.7, topK: 50, topP: 0.8, presencePenalty: 0.2, frequencyPenalty: 0.3, stopSequences: ['END'], continueToEndOfSentence: false };
    const before = structuredClone(value);
    const next = await generateV2Turn(value, provider, { onPhase: (phase) => phases.push(phase) });
    expect(value).toEqual(before); expect(next.world).toEqual(value.world);
    expect(next.turns).toHaveLength(1); expect(next.events).toHaveLength(1); expect(next.draft).toBe('');
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 1024, temperature: 0.7, topK: 50, topP: 0.8, presencePenalty: 0.2, frequencyPenalty: 0.3, continueToEndOfSentence: false, stopSequences: ['END'] }));
    expect(phases).toEqual(['resolve', 'context', 'generate', 'validate', 'commit']);
    const request = provider.generate.mock.calls[0] as unknown as [ProviderRequest];
    expect(request[0].stopSequences).toEqual(['END']);
    expect(request[0].prompt).toContain('PLAYER-PERSPECTIVE WORLD RENDERING CONTRACT');
    expect(request[0].prompt).toContain('TURN RESOLUTION / ENGINE AUTHORITY');
    expect(request[0].prompt).toContain('Do not prefix it with a speaker name');
    expect(request[0]).not.toHaveProperty('world'); expect(request[0]).not.toHaveProperty('generationGrant');
    expect(next.turns[0].diagnostics.viewpointActorId).toBe(value.launch.persona.id);
    expect(next.turns[0].diagnostics.subjectActorId).toBe(value.launch.character!.id);
    expect(next.turns[0].diagnostics.resolutionStatus).toBe('deferred');
  });
  it('rerolls replace the latest event and preserve an unsent draft; deletion removes the event', async () => {
    const first = await generateV2Turn(session(), adapter()); first.draft = 'Unsent words';
    const second = await generateV2Turn(first, adapter('"A different reply."'), { reroll: true });
    expect(second.turns).toHaveLength(1); expect(second.turns[0].id).toBe(first.turns[0].id);
    expect(second.events).toHaveLength(1); expect(second.nextTurn).toBe(first.nextTurn); expect(second.draft).toBe('Unsent words');
    const removed = deleteLastTurn(second); expect(removed.turns).toEqual([]); expect(removed.events).toEqual([]); expect(removed.world).toEqual(second.world);
  });
  it('rejects reroll across a state change instead of rewriting its history', async () => {
    const first = await generateV2Turn(session(), adapter());
    const changed = operateWorld(first, { type: 'advance-clock', seconds: 60 });
    await expect(generateV2Turn(changed, adapter(), { reroll: true })).rejects.toThrow('unchanged world state');
  });
  it('does not commit a rejected, failed, cancelled or expired generation', async () => {
    const value = session(); const copy = structuredClone(value);
    await expect(generateV2Turn(value, adapter('PLAYER: I leave.'))).rejects.toBeInstanceOf(V2DraftRejected);
    await expect(generateV2Turn(value, adapter(`${value.launch.persona.name}: I leave.`))).rejects.toBeInstanceOf(V2DraftRejected);
    const failing: ProviderAdapter = { kind: 'mock', generate: async () => { throw new Error('offline'); } };
    await expect(generateV2Turn(value, failing)).rejects.toThrow('offline');
    const abort = new AbortController();
    const cancelling: ProviderAdapter = { kind: 'mock', generate: async () => { abort.abort(); return adapter().generate(); } };
    await expect(generateV2Turn(value, cancelling, { signal: abort.signal })).rejects.toThrow('cancelled');
    expect(value).toEqual(copy);
    const expired = { ...value, launch: { ...value.launch, expiresAt: 1 } };
    await expect(generateV2Turn(expired, adapter())).rejects.toThrow('expired');
  });
  it('preserves provider-limited text and reports the limit, never hard-cuts it locally', async () => {
    const reply = '*She pauses, considering the';
    const next = await generateV2Turn(session(), adapter(reply, 'max_tokens'));
    expect(next.turns[0].reply).toBe(reply);
    expect(next.turns[0].diagnostics.warnings.join(' ')).toContain('output limit');
    expect(validateV2Reply('<state_patch>{}</state_patch>')).toHaveLength(1);
  });
});

describe('V2 bounded context', () => {
  it('keeps a 200-turn deterministic run bounded and round-trips its ledger without leaking authorization', async () => {
    let value = session(); const provider = adapter();
    for (let i = 0; i < 200; i += 1) value = await generateV2Turn({ ...value, draft: `"Test turn ${i + 1}."` }, provider);
    expect(value.turns).toHaveLength(200); expect(value.events).toHaveLength(200);
    expect(value.turns.at(-1)!.diagnostics.prompt.length).toBeLessThanOrEqual(CONTEXT_CHARACTER_BUDGET);
    expect(value.turns.at(-1)!.diagnostics.omitted.join(' ')).toContain('older exchange(s)');
    const raw = exportV2Session(value); expect(raw).not.toContain(value.launch.launchId); expect(raw).not.toContain('generationGrant');
    const restored = importV2Session(raw, session()); expect(restored.turns).toEqual(value.turns); expect(restored.events).toEqual(value.events);
  });
  it('keeps output presets separate from context capacity and keeps player and subject perception distinct', () => {
    const value = session();
    const player = value.world.actors.find((actor) => actor.role === 'player')!;
    const subject = value.world.actors.find((actor) => actor.role === 'character')!;
    player.knowledge = ['PLAYER PRIVATE MEMORY'];
    subject.knowledge = ['SUBJECT PRIVATE MEMORY'];
    for (const [output, maxTokens] of Object.entries(OUTPUT_PRESETS)) {
      const packet = compileV2Context({ ...value, settings: { ...value.settings, output: output as keyof typeof OUTPUT_PRESETS, maxTokens } }, value.draft);
      expect(packet.prompt.length).toBeLessThanOrEqual(CONTEXT_CHARACTER_BUDGET);
      expect(packet.outputBudget).toBe(maxTokens);
      expect(packet.perception.knownFacts).toEqual(['PLAYER PRIVATE MEMORY']);
      expect(packet.subjectPerception?.knownFacts).toEqual(['SUBJECT PRIVATE MEMORY']);
      expect(packet.prompt).toContain('PLAYER PERCEPTION / OUTPUT VIEW');
      expect(packet.prompt).toContain('AUTHORIZED SUBJECT LOCAL CONTEXT / BEHAVIOR ONLY / NOT OUTPUT AUTHORITY');
    }
  });
  it('includes influences, exposes omissions and refuses oversized mandatory input before sending', () => {
    const value = session(); value.settings.tags = 'Measured'; value.settings.freeform = 'Focus on immediate reactions.';
    const packet = compileV2Context(value, value.draft);
    expect(packet.prompt).toContain('Measured'); expect(packet.prompt).toContain('immediate reactions');
    expect(packet.omitted.join(' ')).toContain('Workshop');
    expect(() => compileV2Context({ ...value, launch: { ...value.launch, scene: 'x'.repeat(30000) } }, value.draft)).toThrow('Nothing was cut or sent');
  });
  it('uses Orbis context blocks only for scene-relevant narrator records', () => {
    const value = session();
    value.launch.character = null;
    value.launch.primaryAsset = { id: 'world:demo', revision: 'rev-1', type: 'world', name: 'Demo world', summary: '', data: {} };
    value.launch.contextBlocks = [{ id: 'place:workshop', title: 'Workshop', content: 'VISIBLE AUTHORED DETAILS' }, { id: 'elsewhere', title: 'Secret', content: 'OFFSCREEN SECRET' }];
    const anchored = operateWorld(value, { type: 'set-scene', locationId: 'place:workshop', presentActorIds: [value.launch.persona.id] });
    const packet = compileV2Context(anchored, 'Look around.');
    expect(packet.prompt).toContain('VISIBLE AUTHORED DETAILS'); expect(packet.prompt).not.toContain('OFFSCREEN SECRET');
  });
});
