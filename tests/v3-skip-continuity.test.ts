import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v3/contracts/launch';
import { compileV2Context, CONTEXT_CHARACTER_BUDGET } from '../src/v3/runtime/context';
import { createV2Session, type V2Session } from '../src/v3/runtime/session';
import { generateV2Turn } from '../src/v3/runtime/engine';
import { MockProvider } from '../src/runtime/providers/mock';
import type { ProviderAdapter, ProviderRequest } from '../src/runtime/providers/types';
import { v2Package } from './v2-fixtures';

function launch(overrides = {}) {
  return publicV2Package(v2Package({
    primaryAsset: { id: 'world:bitterroot', type: 'world', revision: 'rev-1', name: 'Bitterroot', summary: 'A world.', data: {} },
    character: null,
    initialLocationId: 'place:hollowmere',
    relatedAssets: [
      { id: 'place:hollowmere', type: 'place', revision: 'rev-1', name: 'Hollowmere', summary: 'A town.', data: {} },
      { id: 'character:ragna', type: 'character', revision: 'rev-1', name: 'Ragna Holt', summary: 'Mother of the Holt family.', data: { role: 'mother' } },
    ],
    ...overrides,
  } as never));
}

function replyProvider(reply: (turnIndex: number) => string): ProviderAdapter {
  let index = 0;
  return {
    kind: 'mock',
    async generate(request: ProviderRequest) {
      const at = index++;
      const result = await new MockProvider().generate(request);
      return { ...result, text: reply(at) };
    },
  } as ProviderAdapter;
}

async function play(session: V2Session, replies: string[], playerLines: string[]) {
  let current = session;
  for (let i = 0; i < replies.length; i += 1) {
    current = { ...current, draft: playerLines[i] };
    current = await generateV2Turn(current, replyProvider(() => replies[i]), {});
  }
  return current;
}

const normalReply = (n: number) => `*Beat ${n}.* The lantern sways once and settles.`;

describe('V3 immediate continuity guarantee', () => {
  it('1. the continuity window and recent history partition the turns without overlap, in order', async () => {
    const session = await play(createV2Session(launch()), [0, 1, 2, 3, 4, 5, 6].map((n) => normalReply(n)),
      [0, 1, 2, 3, 4, 5, 6].map((n) => `Player action ${n}.`));
    const compiled = compileV2Context(session, 'next', 'skip-persona');

    // continuity exclusively owns the newest two committed turns
    expect(compiled.continuity.continuityTurnIds).toEqual(session.turns.slice(-2).map((turn) => turn.id));
    // recent history covers the next four, older than the continuity window
    expect(compiled.continuity.recentTurnIdsOffered).toEqual(session.turns.slice(-6, -2).map((turn) => turn.id));
    // no turn is offered twice
    const allOffered = [...compiled.continuity.recentTurnIdsOffered, ...compiled.continuity.continuityTurnIds];
    expect(new Set(allOffered).size).toBe(allOffered.length);
    // and every one of them actually reached the prompt, in chronological order
    expect(compiled.continuity.recentTurnIdsOmitted).toEqual([]);
    const positions = allOffered.map((id) => compiled.prompt.indexOf(id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('1b. the newest committed turn is never repeated as a recent-history block', async () => {
    const session = await play(createV2Session(launch()), [0, 1, 2, 3].map((n) => normalReply(n)),
      [0, 1, 2, 3].map((n) => `Player action ${n}.`));
    const compiled = compileV2Context(session, 'next', 'skip-persona');
    const latest = session.turns.at(-1)!;
    const occurrences = compiled.prompt.split(latest.id).length - 1;
    // exactly one mention: the continuity frontier
    expect(occurrences).toBe(1);
    expect(compiled.continuity.recentTurnIdsOffered).not.toContain(latest.id);
  });

  it('2. an extremely large newest reply is clipped, never dropped, while older history cannot replace it', async () => {
    const huge = '*The frontier reply.* ' + 'LONGPROSE '.repeat(5_000) + ' FRONTIEREND';
    const session = await play(createV2Session(launch()),
      [normalReply(0), normalReply(1), normalReply(2), normalReply(3), normalReply(4), huge],
      [0, 1, 2, 3, 4, 5].map((n) => `Player action ${n}.`));
    const latest = session.turns.at(-1)!;
    expect(latest.reply.length).toBeGreaterThan(20_000);

    const compiled = compileV2Context(session, 'next', 'skip-persona');
    // The newest turn must still be present, and must keep its END.
    expect(compiled.prompt).toContain(latest.id);
    expect(compiled.prompt).toContain('FRONTIEREND');
    expect(compiled.continuity.latestTurnMissingFromContext).toBe(false);
    expect(compiled.continuity.continuityFrontierTurnId).toBe(latest.id);
    // It was clipped rather than dropped.
    expect(compiled.continuity.recentTurnIdsClipped).toContain(latest.id);
    // Still inside budget: the fix is not a budget increase.
    expect(compiled.prompt.length).toBeLessThanOrEqual(CONTEXT_CHARACTER_BUDGET);
  });

  it('3. older small turns cannot displace the newest narrative frontier', async () => {
    const huge = '*Frontier.* ' + 'SMALLERPROSE '.repeat(4_000) + ' REALTAIL';
    const session = await play(createV2Session(launch()),
      [normalReply(0), normalReply(1), normalReply(2), normalReply(3), normalReply(4), huge],
      [0, 1, 2, 3, 4, 5].map((n) => `Player action ${n}.`));
    const latest = session.turns.at(-1)!;
    const compiled = compileV2Context(session, 'next', 'skip-persona');
    // The frontier wins regardless of which older turns also survived.
    expect(compiled.prompt).toContain(latest.id);
    expect(compiled.prompt).toContain('REALTAIL');
    expect(compiled.continuity.latestTurnMissingFromContext).toBe(false);
  });

  it('4. Skip immediately after a huge reply keeps the end of that reply and names it as the frontier', async () => {
    const huge = '*Frontier.* ' + 'SKIPPROSE '.repeat(5_000) + ' SKIPTAIL';
    const session = await play(createV2Session(launch()),
      [normalReply(0), normalReply(1), normalReply(2), normalReply(3), normalReply(4), huge],
      [0, 1, 2, 3, 4, 5].map((n) => `Player action ${n}.`));
    const latest = session.turns.at(-1)!;
    const compiled = compileV2Context(session, '', 'skip-persona');

    expect(compiled.prompt).toContain('IMMEDIATE CONTINUITY');
    expect(compiled.prompt).toContain('LATEST COMMITTED TURN / NARRATIVE FRONTIER');
    expect(compiled.prompt).toContain('SKIPTAIL');
    expect(compiled.prompt).toContain('This exchange is the current narrative frontier');
    expect(compiled.prompt).toContain('SKIP TURN CONTINUITY RULES / HIGHEST NARRATIVE PRIORITY');
    expect(compiled.prompt).toContain(latest.id);
  });

  it('5. two consecutive Skips continue from the first Skip result, not the last player turn', async () => {
    let session = createV2Session(launch());
    session = { ...session, draft: 'I walk to the gate.' };
    session = await generateV2Turn(session, replyProvider(() => normalReply(0)), {});

    const firstSkip = await generateV2Turn(session, replyProvider(() => '*FIRSTSKIPBEAT happens.*'), { skipPersona: true });
    const firstSkipTurn = firstSkip.turns.at(-1)!;
    const secondSkip = await generateV2Turn(firstSkip, replyProvider(() => '*SECONDSKIPBEAT happens.*'), { skipPersona: true });
    const secondSkipTurn = secondSkip.turns.at(-1)!;

    expect(firstSkipTurn.reply).toContain('FIRSTSKIPBEAT');
    expect(secondSkipTurn.reply).toContain('SECONDSKIPBEAT');
    // The second skip's context frontier is the FIRST skip, not the player turn.
    const compiled = compileV2Context(secondSkip, '', 'skip-persona');
    expect(compiled.continuity.continuityFrontierTurnId).toBe(secondSkipTurn.id);
    expect(compiled.continuity.continuityTurnIds).toContain(firstSkipTurn.id);
    expect(compiled.prompt).toContain('FIRSTSKIPBEAT');
  });

  it('6. Skip As NPC continues from the newest committed scene state', async () => {
    const session = await play(createV2Session(launch()), [normalReply(0), normalReply(1), normalReply(2)], ['a', 'b', 'c']);
    const latest = session.turns.at(-1)!;
    const compiled = compileV2Context(session, '', 'skip-persona');
    expect(compiled.continuity.continuityFrontierTurnId).toBe(latest.id);
    expect(compiled.prompt).toContain(latest.reply.slice(-30));

    const skipped = await generateV2Turn(session, replyProvider(() => '*Ragna answers.*'), { skipAsActorId: 'character:ragna' });
    const afterSkip = compileV2Context(skipped, '', 'skip-persona');
    expect(afterSkip.continuity.continuityFrontierTurnId).toBe(skipped.turns.at(-1)!.id);
    expect(afterSkip.prompt).toContain('Ragna answers');
  });

  it('7. Reroll then Skip continues from the rerolled reply, not the discarded original', async () => {
    let session = createV2Session(launch());
    session = { ...session, draft: 'I open the ledger.' };
    session = await generateV2Turn(session, replyProvider(() => '*ORIGINALBEAT occurred.*'), {});

    let rerolled = 0;
    session = await generateV2Turn(session, {
      kind: 'mock',
      async generate(request) {
        rerolled += 1;
        const result = await new MockProvider().generate(request);
        return { ...result, text: '*REROLLEDBEAT occurred instead.*' };
      },
    } as ProviderAdapter, { reroll: true });
    expect(session.turns.at(-1)!.reply).toContain('REROLLEDBEAT');
    expect(session.turns.at(-1)!.reply).not.toContain('ORIGINALBEAT');

    const afterReroll = await generateV2Turn(session, replyProvider(() => '*POSTSKIPBEAT.*'), { skipPersona: true });
    const compiled = compileV2Context(afterReroll, '', 'skip-persona');
    expect(compiled.prompt).toContain('REROLLEDBEAT');
    expect(compiled.prompt).not.toContain('ORIGINALBEAT');
  });

  it('8. immediate continuity context is chronologically ordered', async () => {
    const session = await play(createV2Session(launch()), [0, 1, 2, 3, 4].map((n) => normalReply(n)),
      [0, 1, 2, 3, 4].map((n) => `Player action ${n}.`));
    const compiled = compileV2Context(session, '', 'skip-persona');
    const ordered = session.turns.slice(-2).map((turn) => compiled.prompt.indexOf(`Turn ${turn.id} | committed`));
    expect(ordered.every((position) => position >= 0)).toBe(true);
    expect(ordered[0]).toBeLessThan(ordered[1]);
    expect(compiled.continuity.continuityTurnIds).toEqual(session.turns.slice(-2).map((turn) => turn.id));
  });
});
