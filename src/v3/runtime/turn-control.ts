export const SKIPPED_PERSONA_TURN = '__speculus_v3_persona_turn_skipped__';
const SKIPPED_PERSONA_AS_PREFIX = '__speculus_v3_persona_turn_skipped_as__:';

export function skippedPersonaTurnAs(actorId: string): string {
  const normalized = actorId.trim();
  if (!normalized) return SKIPPED_PERSONA_TURN;
  return `${SKIPPED_PERSONA_AS_PREFIX}${normalized}`;
}

export function skippedPersonaActorId(value: string): string | null {
  if (!value.startsWith(SKIPPED_PERSONA_AS_PREFIX)) return null;
  const actorId = value.slice(SKIPPED_PERSONA_AS_PREFIX.length).trim();
  return actorId || null;
}

export function isSkippedPersonaTurn(value: string): boolean {
  return value === SKIPPED_PERSONA_TURN || skippedPersonaActorId(value) !== null;
}
