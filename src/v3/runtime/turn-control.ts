export const SKIPPED_PERSONA_TURN = '[SPECULUS OPERATOR: PERSONA TURN SKIPPED]';

export function isSkippedPersonaTurn(value: string): boolean {
  return value === SKIPPED_PERSONA_TURN;
}
