import { describe, expect, it, vi } from 'vitest';
import { publicV2Package } from '../src/v2/contracts/launch';
import type { ProviderAdapter, ProviderRequest } from '../src/runtime/providers/types';
import { createV2Session, deleteLastTurn, operateWorld, OUTPUT_PRESETS } from '../src/v2/runtime/session';
import { compileV2Context, CONTEXT_CHARACTER_BUDGET } from '../src/v2/runtime/context';
import { generateV2Turn, V2DraftRejected, validateV2Reply } from '../src/v2/runtime/engine';
import { resolveV2PlayerTurn } from '../src/v2/runtime/resolution';
import { resolveTemporalIntent } from '../src/v2/runtime/temporal';
import { perceptionFor, worldClock } from '../src/v2/runtime/world';
import { exportV2Session, importV2Session } from '../src/v2/storage/session';
import { v2Package } from './v2-fixtures';

const session = () => ({ ...createV2Session(publicV2Package(v2Package())), draft: '*I look around.*' });
const adapter = (text = '*Peony looks up.* "Hello."', status: 'completed' | 'max_tokens' = 'completed') => ({ kind: 'mock', generate: vi.fn(async () => ({ text, metadata: { provider: 'mock' as const, model: 'xialong-v1', endpoint: 'mock', durationMs: 1, completionStatus: status } })) }) satisfies ProviderAdapter;

const travelSession = () => {
  const pack = v2Package({
    primaryAsset: {
      id: 'place:hollowmere', type: 'place', revision: 'rev-1', name: 'Hollowmere', summary: 'Regional capital.',
      data: { sourceId: 'hollowmere', travelFromHollowmere: { distanceFromHollowmereKm: 0 } },
    },
    relatedAssets: [{
      id: 'place:brackenjaw', type: 'place', revision: 'rev-1', name: 'Brackenjaw Enclave', summary: 'An upland settlement.',
      data: { sourceId: 'brackenjaw-enclave', parentLocationId: 'splitpine-reach', travelFromHollowmere: { distanceFromHollowmereKm: 82 } },
    }],
    contextBlocks: [],
  });
  return { ...createV2Session(publicV2Package(pack)), draft: '*I ride to Brackenjaw Enclave.*' };
};

describe('isolated V2 world and cognition', () => {
  it('starts with a deterministic engine clock without inventing place or character presence', () => {
    const value = session();
    expect(value.world.locationId).toBeNull(); expect(value.world.elapsedSeconds).toBe(0); expect(value.world.simulationDay).toBe(1);
    expect(worldClock(value.world)).toMatchObject({ time: '08:00', phase: 'morning', isNight: false });
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
  it('keeps knowledge actor-local and derives day rollover from the clock itself', () => {
    const value = session();
    const learned = operateWorld(value, { type: 'record-knowledge', actorId: value.launch.character!.id, fact: 'The lamp is broken.' });
    expect(perceptionFor(learned.world, value.launch.persona.id).knownFacts).toEqual([]);
    expect(perceptionFor(learned.world, value.launch.character!.id).knownFacts).toEqual(['The lamp is broken.']);
    expect(operateWorld(learned, { type: 'advance-clock', seconds: 60 }).world.elapsedSeconds).toBe(60);
    const nextDay = operateWorld(learned, { type: 'advance-clock', seconds: 86400 }).world;
    expect(nextDay.simulationDay).toBe(2); expect(worldClock(nextDay).time).toBe('08:00');
    for (const seconds of [-1, 0, 0.5, Infinity, 86401]) expect(() => operateWorld(learned, { type: 'advance-clock', seconds })).toThrow();
  });
  it('resolves ordinary elapsed time before rendering without trusting unsupported physical claims', () => {
    const value = session();
    const before = structuredClone(value.world);
    const resolved = resolveV2PlayerTurn(value, value.draft);
    expect(value.world).toEqual(before);
    expect(resolved.session.world.elapsedSeconds).toBe(30);
    expect(resolved.session.world.simulationDay).toBe(1);
    expect(resolved.resolution.status).toBe('resolved');
    expect(resolved.resolution.playerActorId).toBe(value.launch.persona.id);
    expect(resolved.resolution.subjectActorId).toBe(value.launch.character!.id);
    expect(resolved.resolution.worldRevisionBefore).toBe(value.world.revision);
    expect(resolved.resolution.worldRevisionAfter).toBe(value.world.revision + 1);
    expect(resolved.resolution.appliedActions).toEqual(['elapsed:turn:30s']);
    expect(resolved.resolution.deferredClaims.join(' ')).toContain('Presence changes');
  });
  it('moves only to a canonical packaged place and lets travel determine arrival time', () => {
    const value = travelSession();
    const resolved = resolveV2PlayerTurn(value, value.draft);
    expect(resolved.session.world.locationId).toBe('place:brackenjaw');
    expect(resolved.resolution.travel).toMatchObject({
      originName: 'Hollowmere', destinationName: 'Brackenjaw Enclave', distanceKm: 82, mode: 'mounted', routeBasis: 'direct-reference',
    });
    expect(resolved.session.world.elapsedSeconds).toBe(49_200);
    expect(worldClock(resolved.session.world)).toMatchObject({ simulationDay: 1, time: '21:40', phase: 'night', isNight: true });
    expect(resolved.resolution.appliedActions[0]).toContain('travel:Hollowmere->Brackenjaw Enclave');
  });
  it('does not let observation or teleport prose silently rewrite location', () => {
    const value = travelSession();
    const seen = resolveV2PlayerTurn(value, '*I think I see Brackenjaw Enclave in the distance.*');
    expect(seen.session.world.locationId).toBe('place:hollowmere');
    const teleported = resolveV2PlayerTurn(value, '*I teleport to Brackenjaw Enclave.*');
    expect(teleported.session.world.locationId).toBe('place:hollowmere');
    expect(teleported.resolution.deferredClaims.join(' ')).toContain('Teleportation is not authorized');
  });
  it('recognizes natural sleep prose and crosses midnight only when the real clock does', () => {
    const late = operateWorld(session(), { type: 'advance-clock', seconds: 15 * 3600 });
    expect(worldClock(late.world).time).toBe('23:00');
    const value = { ...late, draft: '*I closed my eyes and drifted off to sleep.*' };
    const resolved = resolveV2PlayerTurn(value, value.draft, { random: () => 0.5 });
    expect(resolved.session.world.elapsedSeconds).toBe(23 * 3600);
    expect(resolved.session.world.simulationDay).toBe(2);
    expect(worldClock(resolved.session.world).time).toBe('07:00');
    expect(resolved.resolution.narrativeCheck).toBeTruthy();
  });
  it('honors explicit durations, naps and sleep-until-morning phrasing', () => {
    expect(resolveTemporalIntent('*I wait for two hours.*').seconds).toBe(7200);
    expect(resolveTemporalIntent('*I sat by the fire for a while.*').seconds).toBe(900);
    expect(resolveTemporalIntent('*I take a nap for 30 minutes.*', () => 0.5).seconds).toBe(1800);
    expect(resolveTemporalIntent('*I sleep until morning.*', () => 0.5, 23 * 3600).seconds).toBe(8 * 3600);
  });
});

describe('V2 generation transaction', () => {
  it('forwards every native setting, resolves time before rendering, commits stable resolution state, and leaves unsupported prose out of canon', async () => {
    const value = session(); const provider = adapter(); const phases: string[] = [];
    value.settings = { ...value.settings, maxTokens: 1024, temperature: 0.7, topK: 50, topP: 0.8, presencePenalty: 0.2, frequencyPenalty: 0.3, stopSequences: ['END'], continueToEndOfSentence: false };
    const before = structuredClone(value);
    const next = await generateV2Turn(value, provider, { onPhase: (phase) => phases.push(phase) });
    expect(value).toEqual(before); expect(next.world.elapsedSeconds).toBe(30); expect(next.world.simulationDay).toBe(1);
    expect(next.turns).toHaveLength(1); expect(next.events).toHaveLength(2); expect(next.draft).toBe('');
    expect(next.events[0].kind).toBe('operator'); expect(next.events[0].id).toContain(':resolution');
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 1024, temperature: 0.7, topK: 50, topP: 0.8, presencePenalty: 0.2, frequencyPenalty: 0.3, continueToEndOfSentence: false, stopSequences: ['END'] }));
    expect(phases).toEqual(['resolve', 'context', 'generate', 'validate', 'commit']);
    const request = provider.generate.mock.calls[0] as unknown as [ProviderRequest];
    expect(request[0].stopSequences).toEqual(['END']);
    expect(request[0].prompt).toContain('PLAYER-PERSPECTIVE WORLD RENDERING CONTRACT');
    expect(request[0].prompt).toContain('TURN RESOLUTION / ENGINE AUTHORITY');
    expect(request[0].prompt).toContain('"elapsedSeconds":30');
    expect(request[0].prompt).toContain('"simulationDay":1');
    expect(request[0].prompt).toContain('"time":"08:00"');
    expect(request[0].prompt).toContain('"phase":"morning"');
    expect(request[0].prompt).toContain('Do not prefix it with a speaker name');
    expect(request[0]).not.toHaveProperty('world'); expect(request[0]).not.toHaveProperty('generationGrant');
    expect(next.turns[0].diagnostics.viewpointActorId).toBe(value.launch.persona.id);
    expect(next.turns[0].diagnostics.subjectActorId).toBe(value.launch.character!.id);
    expect(next.turns[0].diagnostics.resolutionStatus).toBe('resolved');
    expect(next.turns[0].diagnostics.resolutionElapsedSeconds).toBe(30);
  });
  it('rerolls reuse the resolved clock, preserve an unsent draft, and deletion rolls the automatic clock back', async () => {
    const first = await generateV2Turn(session(), adapter()); first.draft = 'Unsent words';
    const elapsed = first.world.elapsedSeconds;
    const second = await generateV2Turn(first, adapter('"A different reply."'), { reroll: true });
    expect(second.turns).toHaveLength(1); expect(second.turns[0].id).toBe(first.turns[0].id);
    expect(second.events).toHaveLength(2); expect(second.nextTurn).toBe(first.nextTurn); expect(second.draft).toBe('Unsent words');
    expect(second.world.elapsedSeconds).toBe(elapsed);
    const removed = deleteLastTurn(second);
    expect(removed.turns).toEqual([]); expect(removed.events).toEqual([]); expect(removed.world.elapsedSeconds).toBe(0); expect(removed.world.simulationDay).toBe(1);
    expect(worldClock(removed.world).time).toBe('08:00');
  });
  it('rejects reroll and deletion across a later state change instead of rewriting history', async () => {
    const first = await generateV2Turn(session(), adapter());
    const changed = operateWorld(first, { type: 'advance-clock', seconds: 60 });
    await expect(generateV2Turn(changed, adapter(), { reroll: true })).rejects.toThrow('unchanged world state');
    expect(() => deleteLastTurn(changed)).toThrow('unchanged world state');
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
  it('discards provider-limited text instead of committing a cut-off ending', async () => {
    const value = session(); const copy = structuredClone(value);
    const reply = '*She pauses, considering the';
    await expect(generateV2Turn(value, adapter(reply, 'max_tokens'))).rejects.toBeInstanceOf(V2DraftRejected);
    expect(value).toEqual(copy);
    expect(validateV2Reply('<state_patch>{}</state_patch>')).toHaveLength(1);
  });
});

describe('V2 bounded context', () => {
  it('keeps a 200-turn deterministic run bounded and round-trips its ledger without leaking authorization', async () => {
    let value = session(); const provider = adapter();
    for (let i = 0; i < 200; i += 1) value = await generateV2Turn({ ...value, draft: `"Test turn ${i + 1}."` }, provider);
    expect(value.turns).toHaveLength(200); expect(value.events).toHaveLength(400);
    expect(value.world.elapsedSeconds).toBe(200 * 30); expect(value.world.simulationDay).toBe(1);
    expect(worldClock(value.world).time).toBe('09:40');
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
