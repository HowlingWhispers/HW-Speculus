import type { V2Session } from './session';
import { resolveTemporalIntent, type NarrativeDiceResult } from './temporal';
import { applyWorldAction, perceptionFor } from './world';

export const V2_RESOLUTION_SCHEMA = 'speculus-v2-turn-resolution/2' as const;
export type V2ResolutionStatus = 'authoritative-noop' | 'resolved' | 'deferred';

export type V2TurnResolution = {
  schemaVersion: typeof V2_RESOLUTION_SCHEMA;
  status: V2ResolutionStatus;
  playerActorId: string;
  subjectActorId: string | null;
  worldRevisionBefore: number;
  worldRevisionAfter: number;
  elapsedSeconds: number;
  appliedActions: string[];
  deferredClaims: string[];
  narrativeCheck?: NarrativeDiceResult;
  playerPerception: ReturnType<typeof perceptionFor>;
  subjectPerception: ReturnType<typeof perceptionFor> | null;
};

/**
 * Trusted V2 turn-resolution boundary.
 *
 * Freeform prose is still never allowed to author places, presence or canon. A
 * deliberately narrow temporal interpreter may, however, recognize elapsed-time
 * intent and commit it before prose rendering. Unsupported physical claims remain
 * deferred rather than guessed into authoritative state.
 */
export function resolveV2PlayerTurn(
  session: V2Session,
  player = '',
  options: { skipPersona?: boolean; reroll?: boolean; random?: () => number } = {},
): { session: V2Session; resolution: V2TurnResolution } {
  const playerActorId = session.launch.persona.id;
  const subjectActorId = session.launch.character?.id ?? null;
  const before = session.world.revision;
  const skipped = options.skipPersona === true;
  const reroll = options.reroll === true;

  let resolvedSession = session;
  let appliedActions: string[] = [];
  let narrativeCheck: NarrativeDiceResult | undefined;
  let elapsedSeconds = 0;
  const deferredClaims: string[] = [];

  if (!skipped && !reroll) {
    const temporal = resolveTemporalIntent(player, options.random);
    elapsedSeconds = temporal.seconds;
    narrativeCheck = temporal.check;
    const world = applyWorldAction(session.world, {
      type: 'advance-clock', seconds: temporal.seconds, days: temporal.dayAdvance,
    }, session.launch);
    resolvedSession = { ...session, world };
    appliedActions = [temporal.label];
    deferredClaims.push('Movement, presence changes, resource use and other unsupported physical claims remain deferred unless an authoritative resolver handles them.');
  }

  const after = resolvedSession.world.revision;
  const status: V2ResolutionStatus = skipped || reroll ? 'authoritative-noop' : appliedActions.length ? 'resolved' : 'deferred';
  return {
    session: resolvedSession,
    resolution: {
      schemaVersion: V2_RESOLUTION_SCHEMA,
      status,
      playerActorId,
      subjectActorId,
      worldRevisionBefore: before,
      worldRevisionAfter: after,
      elapsedSeconds,
      appliedActions,
      deferredClaims,
      narrativeCheck,
      playerPerception: perceptionFor(resolvedSession.world, playerActorId),
      subjectPerception: subjectActorId ? perceptionFor(resolvedSession.world, subjectActorId) : null,
    },
  };
}
