import type { SafeProviderMetadata, SimulationAsset } from '../../src/runtime/schema/types.js';
import type { ProviderRequest, ProviderResult } from '../../src/runtime/providers/types.js';
import { bridgeErrorMessage } from './bridge-error.js';

export type GenerationSession = {
  launchId: string;
  generationGrant: string;
  source: Pick<SimulationAsset, 'id' | 'revision' | 'type'>;
  expiresAt: number;
};

function extractText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.reply === 'string') return record.reply;
  return '';
}

const VALID_COMPLETION_STATUSES = new Set<SafeProviderMetadata['completionStatus']>(['completed', 'max_tokens', 'timeout', 'cancelled', 'bridge_interruption', 'unknown']);

export function extractCompletion(value: unknown): Pick<SafeProviderMetadata, 'completionStatus' | 'finishReason'> {
  if (!value || typeof value !== 'object') return { completionStatus: 'unknown' };
  const record = value as Record<string, unknown>;
  const nested = record.metadata && typeof record.metadata === 'object'
    ? record.metadata as Record<string, unknown>
    : {};

  // Read explicit top-level/nested completion status first. Failure and
  // truncation evidence always overrides a success claim; contradictory or
  // invalid metadata must never become `completed`.
  const explicitValues = [record.completionStatus, nested.completionStatus].filter((value) => value !== undefined);
  const invalid = explicitValues.some((value) => typeof value !== 'string' || !VALID_COMPLETION_STATUSES.has(value as SafeProviderMetadata['completionStatus']))
    || [record.truncated, nested.truncated].some((value) => value !== undefined && typeof value !== 'boolean')
    || [record.finishReason, record.finish_reason, record.stopReason, record.stop_reason,
      nested.finishReason, nested.finish_reason, nested.stopReason, nested.stop_reason]
      .some((value) => value !== undefined && typeof value !== 'string');

  const raw = record.finishReason ?? record.finish_reason ?? record.stopReason ?? record.stop_reason
    ?? nested.finishReason ?? nested.finish_reason ?? nested.stopReason ?? nested.stop_reason;
  const finishReason = typeof raw === 'string' ? raw : undefined;

  const signals = [...explicitValues];
  // Inspect every reason, not just the preferred display reason.
  for (const value of [record.finishReason, record.finish_reason, record.stopReason, record.stop_reason,
    nested.finishReason, nested.finish_reason, nested.stopReason, nested.stop_reason]) {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    if (['length', 'max_tokens', 'token_limit'].includes(normalized)) signals.push('max_tokens');
    else if (normalized === 'timeout') signals.push('timeout');
    else if (['cancelled', 'canceled'].includes(normalized)) signals.push('cancelled');
    else if (['interrupted', 'bridge_interruption', 'error'].includes(normalized)) signals.push('bridge_interruption');
    else if (['stop', 'complete', 'completed', 'end_turn', 'eos'].includes(normalized)) signals.push('completed');
  }
  if (record.truncated === true || nested.truncated === true) signals.push('max_tokens');
  // Never regenerate a known failed/interrupted draft, even when truncated too.
  for (const status of ['cancelled', 'timeout', 'bridge_interruption'] as const) {
    if (signals.includes(status)) return { completionStatus: status, finishReason };
  }
  if (invalid) return { completionStatus: 'bridge_interruption', finishReason };
  if (signals.includes('max_tokens')) return { completionStatus: 'max_tokens', finishReason };
  if (signals.includes('unknown')) return { completionStatus: 'unknown', finishReason };
  return { completionStatus: signals.includes('completed') ? 'completed' : 'unknown', finishReason };
}

export async function generateThroughOrbis(session: GenerationSession, request: ProviderRequest): Promise<ProviderResult> {
  const base = process.env.ORBIS_GENERATION_API_URL;
  if (!base) throw new Error('The Orbis generation bridge is not configured.');
  if (session.expiresAt <= Date.now()) throw new Error('The Orbis simulation authorization has expired. Launch the item again.');
  const url = base.replace(/\/$/, '');
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.generationGrant}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          launchId: session.launchId,
          source: session.source,
          prompt: request.prompt,
          model: request.model,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          topK: request.topK,
          topP: request.topP,
          presencePenalty: request.presencePenalty,
          frequencyPenalty: request.frequencyPenalty,
          stopSequences: request.stopSequences,
          continueToEndOfSentence: request.continueToEndOfSentence,
          reroll: request.reroll === true,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('MODEL TIMEOUT: the Orbis generation bridge exceeded 180 seconds.');
      const detail = error instanceof Error ? error.message : 'network request failed';
      throw new Error(`ORBIS NETWORK FAILURE: ${detail}`);
    }
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      throw new Error(bridgeErrorMessage(response.status, failure, response.headers.get('x-request-id')));
    }
    const value: unknown = await response.json();
    const text = extractText(value);
    if (!text.trim()) throw new Error('EMPTY GENERATION: Orbis generation bridge returned no roleplay text.');
    const parsed = new URL(url);
    const metadata: SafeProviderMetadata = {
      provider: 'orbis',
      model: request.model,
      endpoint: `${parsed.origin}${parsed.pathname}`,
      durationMs: Date.now() - started,
      requestId: response.headers.get('x-request-id') ?? undefined,
      inputTokensEstimate: Math.ceil(request.prompt.length / 4),
      requestedMaxTokens: request.maxTokens,
      ...extractCompletion(value),
    };
    return { text, metadata };
  } finally {
    clearTimeout(timeout);
  }
}
