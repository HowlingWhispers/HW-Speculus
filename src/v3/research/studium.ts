import type { V2Session } from '../runtime/session';

export async function submitLatestTurnToStudium(session: V2Session, options: { reroll?: boolean } = {}): Promise<void> {
  const turn = session.turns.at(-1);
  if (!turn) return;

  const response = await fetch('/api/v3/research', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      launchId: session.launch.launchId,
      sessionId: session.id,
      turnId: turn.id,
      occurredAt: turn.createdAt,
      player: turn.player,
      reply: turn.reply,
      worldRevision: turn.worldRevision,
      locationId: session.world.locationId,
      reroll: options.reroll ?? false,
      engine: 'v3',
    }),
  });

  if (!response.ok) {
    throw new Error(`Studium research handoff failed with HTTP ${response.status}.`);
  }
}

export async function retractLatestTurnFromStudium(session: V2Session): Promise<void> {
  const turn = session.turns.at(-1);
  if (!turn) return;

  const response = await fetch('/api/v3/research/retract', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      launchId: session.launch.launchId,
      sessionId: session.id,
      turnId: turn.id,
    }),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Studium research retraction failed with HTTP ${response.status}.`);
  }
}
