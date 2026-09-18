import type { ProviderAdapter } from '../../runtime/providers/types';
import { compileV2Context, CONTEXT_CHARACTER_BUDGET } from './context';
import { decodeV2SerializedRoleplayArtifacts, normalizeV2RoleplayFormat, stripV3ProtocolArtifacts, type EnginePhase } from './engine';
import { settingsSchema, type V2Session } from './session';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RESPONSE_MARKER = '\nContinue with in-world prose only.\n';

function withExistingPersonaDraft(prompt: string, draft: string) {
  if (!draft.trim()) return prompt;
  if (!prompt.endsWith(RESPONSE_MARKER)) throw new Error('V3 impersonation response boundary is missing.');
  const guidance = [
    '\nThe player composer already contains the following operator-authored text. Treat it as fixed context and as the beginning of this same next player turn. Preserve it exactly:',
    draft,
    'Continue from that text naturally. Do not repeat, rewrite, summarize or replace any of it. Generate only the new continuation that belongs after the existing composer text.',
    'If the existing text ends mid-sentence or with an open roleplay delimiter, continue that exact unfinished thought or action. Otherwise continue with the next immediate player beat.',
    '',
  ].join('\n');
  const next = `${prompt.slice(0, -RESPONSE_MARKER.length)}${guidance}${RESPONSE_MARKER}`;
  if (next.length > CONTEXT_CHARACTER_BUDGET) {
    throw new Error('The existing player draft plus required V3 context exceeds the context allowance. Shorten the draft before using Impersonate.');
  }
  return next;
}

function mergePersonaDraft(existing: string, continuation: string) {
  if (!existing.trim()) return continuation;
  const exactPrefix = existing.trim();
  let next = continuation;
  if (next.startsWith(exactPrefix)) next = next.slice(exactPrefix.length).trimStart();
  if (!next) return existing;
  const existingEnd = existing.trimEnd();
  const separator = /\s$/.test(existing)
    ? ''
    : /(?:[.!?*\]"”])$/.test(existingEnd)
      ? '\n'
      : ' ';
  return `${existing}${separator}${next}`;
}

export async function generateV2PersonaDraft(session: V2Session, provider: ProviderAdapter, options: {
  signal?: AbortSignal; onPhase?: (phase: EnginePhase) => void;
} = {}): Promise<string> {
  const settings = settingsSchema.parse(session.settings);
  if (options.signal?.aborted) throw new Error('Generation cancelled. No provider call was made.');
  if (session.launch.expiresAt <= Date.now()) throw new Error('V3 authorization expired. Relaunch from Orbis, then import your V3 export.');

  options.onPhase?.('context');
  const compiled = compileV2Context(session, '', 'impersonate-persona');
  const prompt = withExistingPersonaDraft(compiled.prompt, session.draft);
  options.onPhase?.('generate');
  const result = await provider.generate({
    prompt, model: session.launch.model,
    temperature: settings.temperature, maxTokens: settings.maxTokens, topK: settings.topK, topP: settings.topP,
    presencePenalty: settings.presencePenalty, frequencyPenalty: settings.frequencyPenalty,
    stopSequences: [...settings.stopSequences], continueToEndOfSentence: settings.continueToEndOfSentence,
    signal: options.signal,
  });
  if (options.signal?.aborted) throw new Error('Generation cancelled. The composer was not changed.');

  options.onPhase?.('validate');
  const raw = result.text.trim();
  const decoded = stripV3ProtocolArtifacts(decodeV2SerializedRoleplayArtifacts(raw));
  if (!decoded) throw new Error('The model returned an empty player draft.');
  if (result.metadata.completionStatus === 'max_tokens') {
    throw new Error('The generated player draft reached the hard output ceiling and was discarded instead of inserting a cut-off turn. Try again or use a larger output preset.');
  }
  if (/<\|(?:user|assistant|system|im_start|im_end)\|>|<\/?(?:world_state|state_patch|analysis)>/i.test(decoded)) {
    throw new Error('The generated player draft exposed control data and was rejected.');
  }
  const personaName = session.launch.persona.name.trim();
  if (personaName && new RegExp(`^\\s*${escapeRegExp(personaName)}\\s*:`, 'im').test(decoded)) {
    throw new Error('The generated player draft used a speaker label instead of direct roleplay prose.');
  }
  const characterName = session.launch.character?.name.trim() ?? '';
  if (characterName) {
    const escaped = escapeRegExp(characterName);
    if (new RegExp(`^\\s*${escaped}\\s*:`, 'im').test(decoded)
      || new RegExp(`^\\s*\\*\\s*${escaped}\\b`, 'im').test(decoded)) {
      throw new Error('The generated player draft tried to write the character turn.');
    }
  }
  if (/^\s*(?:SIMULATION NARRATOR|NARRATOR)\s*:/im.test(decoded)) {
    throw new Error('The generated player draft tried to write the narrator turn.');
  }
  const continuation = normalizeV2RoleplayFormat(decoded);
  const combined = mergePersonaDraft(session.draft, continuation);
  if (combined.length > 16000) throw new Error('The generated player draft exceeds the composer limit.');
  return combined;
}
