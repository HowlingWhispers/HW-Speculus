import type { V4Session } from '../runtime/session';

export const detachedTranscriptChannelName = (sessionId: string) => `speculus-v4-transcript:${sessionId}`;

export type DetachedTranscriptMessage =
  | { type: 'probe'; sessionId: string }
  | { type: 'ready'; sessionId: string }
  | { type: 'closed'; sessionId: string }
  | { type: 'state'; sessionId: string; branchId: string; sequence: number; session: V4Session; busy: boolean };
