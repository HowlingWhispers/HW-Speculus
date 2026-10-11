import type { ProviderAdapter, ProviderRequest, ProviderResult } from '../../runtime/providers/types';
import type { V4OutputContract } from './context';
import { assertV4FormattingOnly, tryV4LocalRoleplayRepair, v4RoleplayFormattingIssues } from './output-format';

export function assertV4NotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Generation cancelled. No turn or composer change was committed.', 'AbortError');
}

function normalizeCompletion(result: ProviderResult): ProviderResult {
  if (!result || typeof result.text !== 'string' || !result.metadata
    || typeof result.metadata !== 'object' || Array.isArray(result.metadata)) {
    throw new Error('V4 provider returned invalid completion metadata.');
  }
  const metadata = result.metadata;
  const status = metadata.completionStatus;
  if (!Number.isFinite(metadata.durationMs) || typeof metadata.durationMs !== 'number' || metadata.durationMs < 0
    || typeof metadata.provider !== 'string' || !metadata.provider.trim()
    || typeof metadata.model !== 'string' || !metadata.model.trim()
    || [metadata.endpoint, metadata.requestId, metadata.finishReason].some((value) => value !== undefined && (typeof value !== 'string' || !value.trim()))
    || [metadata.inputTokensEstimate, metadata.requestedMaxTokens].some((value) => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
    || (status !== undefined && !['completed', 'unknown', 'max_tokens', 'timeout', 'cancelled', 'bridge_interruption'].includes(status))) {
    throw new Error('V4 provider returned invalid completion metadata.');
  }
  const signals: string[] = status === undefined ? [] : [status];
  const reason = metadata.finishReason?.trim().toLowerCase();
  if (reason && ['length', 'max_tokens', 'token_limit'].includes(reason)) signals.push('max_tokens');
  else if (reason === 'timeout') signals.push('timeout');
  else if (reason && ['cancelled', 'canceled'].includes(reason)) signals.push('cancelled');
  else if (reason && ['interrupted', 'bridge_interruption', 'error'].includes(reason)) signals.push('bridge_interruption');
  else if (reason && ['stop', 'complete', 'completed', 'end_turn', 'eos'].includes(reason)) signals.push('completed');
  const failure = ['cancelled', 'timeout', 'bridge_interruption'].find((value) => signals.includes(value));
  if (failure) throw new Error(`V4 provider completion failed (${failure}). The draft was discarded before repair or commit.`);
  const completionStatus = signals.includes('max_tokens') ? 'max_tokens'
    : signals.includes('unknown') ? 'unknown'
      : signals.includes('completed') ? 'completed' : 'unknown';
  return { ...result, metadata: { ...metadata, completionStatus } };
}

// The runtime owns the entire original + one repair budget; transports never retry.
export async function generateV4Output(provider: ProviderAdapter, request: ProviderRequest, contract: V4OutputContract, options: {
  inspect: (raw: string, repair: boolean) => string;
  fixedPrefix?: string;
}) {
  const check = (result: ProviderResult, repair: boolean) => {
    assertV4NotCancelled(request.signal);
    const normalized = normalizeCompletion(result);
    return { result: normalized, text: options.inspect(normalized.text, repair) };
  };
  assertV4NotCancelled(request.signal);
  const first = check(await provider.generate(request), false);
  let result = first.result;
  const initial = first.text;
  const truncated = result.metadata.completionStatus === 'max_tokens';
  const malformed = v4RoleplayFormattingIssues(initial).length > 0;
  // Fix provably mechanical markup errors without another creative-model call.
  // Persona drafts with fixed operator-authored prefixes retain their guarded path.
  if (malformed && !truncated && !options.fixedPrefix) {
    const locallyRepaired = tryV4LocalRoleplayRepair(initial);
    if (locallyRepaired !== null) {
      return {
        result: { ...result, text: locallyRepaired },
        text: locallyRepaired,
        reason: 'safe local roleplay formatting',
        attempts: 1,
      };
    }
  }
  let text = initial;
  const reason = truncated ? 'hard-ceiling truncation' : malformed ? 'roleplay formatting' : null;
  if (reason) {
    const target = Math.max(1, Math.min(Math.floor((contract.targetMinTokens + contract.targetMaxTokens) / 4), Math.floor(request.maxTokens / 2)));
    const prompt = [
      request.prompt,
      '\nREPAIR OVERRIDE / ONE REMAINING ATTEMPT',
      truncated
        ? `The draft hit the hard ceiling. Regenerate a substantially shorter complete beat: aim for about ${target} tokens, not a quota. This numeric target overrides ALL original length and paragraph instructions. Preserve personality, dialogue and scene continuity. Do not continue the cut-off text, pad, recap, or start another exchange.`
        : 'FORMAT REPAIR ONLY: preserve every ordered word, punctuation mark, Unicode character and already unambiguous action/dialogue/thought role. Change only roleplay delimiters and whitespace. Do not shorten, paraphrase, expand, or continue. Output only the repaired in-world prose, never an instruction or explanation about formatting.',
      options.fixedPrefix ? 'Return the full player draft, starting with the exact fixed operator-authored prefix unchanged as supplied in the original request.' : 'Return only the complete in-world response.',
      'Close every quote, action delimiter and inner-voice bracket naturally before stopping.',
      ...(!truncated ? ['DRAFT TO REPAIR:', initial] : []),
    ].join('\n');
    assertV4NotCancelled(request.signal);
    const firstDuration = result.metadata.durationMs;
    const second = check(await provider.generate({
      ...request, prompt, temperature: Math.min(request.temperature, truncated ? 0.65 : 0.2),
      presencePenalty: 0, frequencyPenalty: 0, reroll: false, continueToEndOfSentence: false,
    }), true);
    text = second.text;
    result = { ...second.result, metadata: { ...second.result.metadata, durationMs: firstDuration + second.result.metadata.durationMs } };
    if (result.metadata.completionStatus === 'max_tokens') throw new Error('The second V4 draft reached the hard output ceiling and was discarded before commit.');
    if (!truncated) assertV4FormattingOnly(initial, text);
    if (v4RoleplayFormattingIssues(text).length) throw new Error('The V4 repair still contains invalid roleplay formatting. The draft was discarded before commit.');
  }
  assertV4NotCancelled(request.signal);
  return { result, text, reason, attempts: reason ? 2 : 1 };
}
