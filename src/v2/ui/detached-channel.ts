import type { V2Session } from '../runtime/session';

export const detachedTranscriptChannelName = (sessionId: string) => `speculus-v2-transcript:${sessionId}`;

export type DetachedTranscriptMessage =
  | { type: 'probe'; sessionId: string }
  | { type: 'ready'; sessionId: string }
  | { type: 'closed'; sessionId: string }
  | { type: 'state'; sessionId: string; session: V2Session; busy: boolean };
