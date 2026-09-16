import type { V2Session } from './session';
import { resolveTemporalIntent, type NarrativeDiceResult } from './temporal';
import { resolveTravelIntent, type TravelResult } from './travel';
import { applyWorldAction, perceptionFor } from './world';

export const V2_RESOLUTION_SCHEMA = 'speculus-v2-turn-resolution/3' as const;
export type V2ResolutionStatus = 'authoritative-noop' | 'resolved' | 'deferred';
export type ResolvedTravel = Extract<TravelResult, { kind: 'resolved' }>;

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
  travel?: ResolvedTravel;
  playerPerception: ReturnType<typeof perceptionFor>;
  subjectPerception: ReturnType<typeof perceptionFor> | null;
};

/**
 * Trusted V2 turn-resolution boundary.
 *
 * Freeform prose can propose an action but cannot directly author world state. A
 * narrow temporal interpreter and canonical travel resolver may commit trusted
 * effects before prose rendering. Unsupported physical claims remain deferred.
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
  let travelResolution: ResolvedTravel | undefined;
  let elapsedSeconds = 0;
  const deferredClaims: string[] = [];

  if (!skipped && !reroll) {
    const travel = resolveTravelIntent(session.launch, session.world, player);
    if (travel.kind === 'resolved') {
      const world = applyWorldAction(session.world, {
        type: 'travel', actorId: playerActorId, locationId: travel.destinationId, seconds: travel.seconds,
      }, session.launch);
      resolvedSession = { ...session, world };
      elapsedSeconds = travel.seconds;
      travelResolution = travel;
      appliedActions = [`travel:${travel.originName}->${travel.destinationName}:${travel.distanceKm}km:${travel.mode}:${travel.seconds}s`];
      deferredClaims.push('Companion movement, supplies, fatigue, encounters and other travel side effects are not yet resolved automatically.');
    } else {
      const temporal = resolveTemporalIntent(player, options.random, session.world.timeOfDaySeconds);
      elapsedSeconds = temporal.seconds;
      narrativeCheck = temporal.check;
      const world = applyWorldAction(session.world, { type: 'advance-clock', seconds: temporal.seconds }, session.launch);
      resolvedSession = { ...session, world };
      appliedActions = [temporal.label];
      if (travel.kind === 'deferred') deferredClaims.push(travel.reason);
      deferredClaims.push('Presence changes, resource use and other unsupported physical claims remain deferred unless an authoritative resolver handles them.');
    }
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
      travel: travelResolution,
      playerPerception: perceptionFor(resolvedSession.world, playerActorId),
      subjectPerception: subjectActorId ? perceptionFor(resolvedSession.world, subjectActorId) : null,
    },
  };
}
