import type { ProviderAdapter } from '../../runtime/providers/types';
import { compileV2Context } from './context';
import { decodeV2SerializedRoleplayArtifacts, normalizeV2RoleplayFormat, type EnginePhase } from './engine';
import { settingsSchema, type V2Session } from './session';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function generateV2PersonaDraft(session: V2Session, provider: ProviderAdapter, options: {
  signal?: AbortSignal; onPhase?: (phase: EnginePhase) => void;
} = {}): Promise<string> {
  const settings = settingsSchema.parse(session.settings);
  if (options.signal?.aborted) throw new Error('Generation cancelled. No provider call was made.');
  if (session.launch.expiresAt <= Date.now()) throw new Error('V2 authorization expired. Relaunch from Orbis, then import your V2 export.');

  options.onPhase?.('context');
  const compiled = compileV2Context(session, '', 'impersonate-persona');
  options.onPhase?.('generate');
  const result = await provider.generate({
    prompt: compiled.prompt, model: session.launch.model,
    temperature: settings.temperature, maxTokens: settings.maxTokens, topK: settings.topK, topP: settings.topP,
    presencePenalty: settings.presencePenalty, frequencyPenalty: settings.frequencyPenalty,
    stopSequences: [...settings.stopSequences], continueToEndOfSentence: settings.continueToEndOfSentence,
    signal: options.signal,
  });
  if (options.signal?.aborted) throw new Error('Generation cancelled. The composer was not changed.');

  options.onPhase?.('validate');
  const raw = result.text.trim();
  const decoded = decodeV2SerializedRoleplayArtifacts(raw);
  if (!decoded) throw new Error('The model returned an empty player draft.');
  if (result.metadata.completionStatus === 'max_tokens') {
    throw new Error('The generated player draft reached the hard output ceiling and was discarded instead of inserting a cut-off turn. Try again or use a larger output preset.');
  }
  if (decoded.length > 16000) throw new Error('The generated player draft exceeds the composer limit.');
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
  return normalizeV2RoleplayFormat(decoded);
}
