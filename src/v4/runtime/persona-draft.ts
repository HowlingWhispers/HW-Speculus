import type { ProviderAdapter } from '../../runtime/providers/types';
import { compileV4Context, CONTEXT_CHARACTER_BUDGET } from './context';
import { decodeV4SerializedRoleplayArtifacts, stripV4ProtocolArtifacts, validateV4Reply, type EnginePhase } from './engine';
import { settingsSchema, type V4Session } from './session';
import { assertV4NotCancelled, generateV4Output } from './generation';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RESPONSE_MARKER = '\n[IN-WORLD RESPONSE]\n';

function withExistingPersonaDraft(prompt: string, draft: string) {
  if (!draft.trim()) return prompt;
  if (!prompt.endsWith(RESPONSE_MARKER)) throw new Error('V4 impersonation response boundary is missing.');
  const guidance = [
    '\nThe player composer already contains the following operator-authored text. Treat it as fixed context and as the beginning of this same next player turn. Preserve it exactly:',
    draft,
    'Continue from that text naturally. Do not repeat, rewrite, summarize or replace any of it. Generate only the new continuation that belongs after the existing composer text.',
    'If the existing text ends mid-sentence or with an open roleplay delimiter, continue that exact unfinished thought or action. Otherwise continue with the next immediate player beat.',
    '',
  ].join('\n');
  const next = `${prompt.slice(0, -RESPONSE_MARKER.length)}${guidance}${RESPONSE_MARKER}`;
  if (next.length > CONTEXT_CHARACTER_BUDGET) {
    throw new Error('The existing player draft plus required V4 context exceeds the context allowance. Shorten the draft before using Impersonate.');
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

export async function generateV4PersonaDraft(session: V4Session, provider: ProviderAdapter, options: {
  signal?: AbortSignal; onPhase?: (phase: EnginePhase) => void;
} = {}): Promise<string> {
  const settings = settingsSchema.parse(session.settings);
  if (options.signal?.aborted) throw new Error('Generation cancelled. No provider call was made.');
  if (session.launch.expiresAt <= Date.now()) throw new Error('V4 authorization expired. Relaunch from Orbis, then import your V4 export.');

  options.onPhase?.('context');
  const compiled = compileV4Context(session, '', 'impersonate-persona');
  const prompt = withExistingPersonaDraft(compiled.prompt, session.draft);
  options.onPhase?.('generate');
  const generated = await generateV4Output(provider, {
    prompt, model: session.launch.model,
    temperature: settings.temperature, maxTokens: settings.maxTokens, topK: settings.topK, topP: settings.topP,
    presencePenalty: settings.presencePenalty, frequencyPenalty: settings.frequencyPenalty,
    stopSequences: [...settings.stopSequences], continueToEndOfSentence: settings.continueToEndOfSentence,
    signal: options.signal,
  }, compiled.outputContract, {
    fixedPrefix: session.draft,
    inspect(raw, repair) {
      const decoded = stripV4ProtocolArtifacts(decodeV4SerializedRoleplayArtifacts(raw.trim()));
      const combined = repair && session.draft.trim() ? decoded : mergePersonaDraft(session.draft, decoded);
      if (repair && session.draft.trim() && !combined.startsWith(session.draft)) {
        throw new Error('The player draft repair changed the fixed operator-authored prefix.');
      }
      const issues = [...validateV4Reply(raw, session.launch.persona.name), ...validateV4Reply(combined, session.launch.persona.name)];
      if (issues.length) throw new Error(issues.join(' '));
      validatePersonaDraft(decoded, session);
      validatePersonaDraft(combined, session);
      if (combined.length > 16000) throw new Error('The generated player draft exceeds the composer limit.');
      return combined;
    },
  });
  if (options.signal?.aborted) throw new Error('Generation cancelled. The composer was not changed.');

  options.onPhase?.('validate');
  assertV4NotCancelled(options.signal);
  return generated.text;
}

function validatePersonaDraft(decoded: string, session: V4Session) {
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
}
