import type { V2Session } from './session';
import { perceptionFor } from './world';

export const V2_RESOLUTION_SCHEMA = 'speculus-v2-turn-resolution/1' as const;
export type V2ResolutionStatus = 'authoritative-noop' | 'deferred';

export type V2TurnResolution = {
  schemaVersion: typeof V2_RESOLUTION_SCHEMA;
  status: V2ResolutionStatus;
  playerActorId: string;
  subjectActorId: string | null;
  worldRevisionBefore: number;
  worldRevisionAfter: number;
  appliedActions: string[];
  deferredClaims: string[];
  playerPerception: ReturnType<typeof perceptionFor>;
  subjectPerception: ReturnType<typeof perceptionFor> | null;
};

/**
 * Phase-2 resolution boundary.
 *
 * Freeform prose is not trusted to mutate authoritative physical state. Until the
 * movement graph and semantic action resolver exist, normal player prose is
 * explicitly deferred rather than guessed into locations, time or presence.
 * This still gives the generation transaction a real resolve -> state ->
 * perception boundary and prevents the renderer from being the state authority.
 */
export function resolveV2PlayerTurn(session: V2Session, options: { skipPersona?: boolean } = {}): {
  session: V2Session;
  resolution: V2TurnResolution;
} {
  const playerActorId = session.launch.persona.id;
  const subjectActorId = session.launch.character?.id ?? null;
  const revision = session.world.revision;
  const skipped = options.skipPersona === true;

  return {
    session,
    resolution: {
      schemaVersion: V2_RESOLUTION_SCHEMA,
      status: skipped ? 'authoritative-noop' : 'deferred',
      playerActorId,
      subjectActorId,
      worldRevisionBefore: revision,
      worldRevisionAfter: revision,
      appliedActions: [],
      deferredClaims: skipped ? [] : [
        'Freeform player prose was not converted into authoritative movement, elapsed time, presence or canon changes.',
        'Physical action resolution remains deferred until trusted semantic resolution and spacetime rules can validate it.',
      ],
      playerPerception: perceptionFor(session.world, playerActorId),
      subjectPerception: subjectActorId ? perceptionFor(session.world, subjectActorId) : null,
    },
  };
}
