import { describe, expect, it } from 'vitest';
import { extractCompletion } from '../server/providers/provider-service';

describe('shared completion reconciliation only', () => {
  it.each<[unknown, string]>([
    [{}, 'unknown'], [null, 'unknown'],
    [{ completionStatus: 'completed' }, 'completed'],
    [{ metadata: { completionStatus: 'timeout' } }, 'timeout'],
    [{ completionStatus: 'completed', metadata: { completionStatus: 'cancelled' } }, 'cancelled'],
    [{ completionStatus: 'timeout', finish_reason: 'stop' }, 'timeout'],
    [{ completionStatus: 'bridge_interruption', truncated: true }, 'bridge_interruption'],
    [{ completionStatus: 'max_tokens', metadata: { finishReason: 'timeout' } }, 'timeout'],
    [{ finish_reason: 'stop', metadata: { stop_reason: 'interrupted' } }, 'bridge_interruption'],
    [{ completionStatus: 'completed', truncated: true }, 'max_tokens'],
    [{ finishReason: 'stop', metadata: { truncated: true } }, 'max_tokens'],
    [{ completionStatus: 'unknown', finish_reason: 'stop' }, 'unknown'],
    [{ completionStatus: 'made-up', finishReason: 'stop' }, 'bridge_interruption'],
    [{ completionStatus: 42 }, 'bridge_interruption'],
    [{ completionStatus: null }, 'bridge_interruption'],
    [{ completionStatus: 'completed', finishReason: 42 }, 'bridge_interruption'],
    [{ completionStatus: 'completed', truncated: 'true' }, 'bridge_interruption'],
    [{ metadata: { stop_reason: false } }, 'bridge_interruption'],
    ...['length', 'max_tokens', 'token_limit'].map((finish_reason): [unknown, string] => [{ finish_reason }, 'max_tokens']),
    ...['stop', 'complete', 'completed', 'end_turn', 'eos'].map((finishReason): [unknown, string] => [{ finishReason }, 'completed']),
    ...['cancelled', 'canceled'].map((stopReason): [unknown, string] => [{ stopReason }, 'cancelled']),
    ...['interrupted', 'bridge_interruption', 'error'].map((stop_reason): [unknown, string] => [{ stop_reason }, 'bridge_interruption']),
  ])('reconciles %j as %s without fabricating success', (value, expected) => {
    expect(extractCompletion(value).completionStatus).toBe(expected);
  });
  it('preserves safe finish reason without changing requests or transport', () => {
    expect(extractCompletion({ metadata: { finish_reason: 'length' } })).toEqual({ completionStatus: 'max_tokens', finishReason: 'length' });
  });
});
