export const SKIPPED_PERSONA_TURN = '__speculus_v3_persona_turn_skipped__';

export function isSkippedPersonaTurn(value: string): boolean {
  return value === SKIPPED_PERSONA_TURN;
}
