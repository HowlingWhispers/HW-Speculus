import type { ProviderAdapter } from '../../runtime/providers/types';
import { commitRelationshipEvent, getRelationship, removeRelationshipTurns } from '../../runtime/relationships/core';
import { heuristicRelationshipScorer } from '../../runtime/relationships/evaluator';
import { compileV2Context } from './context';
import { resolveV2PlayerTurn } from './resolution';
import { rollbackTurnOwnedActions, settingsSchema, type V2Diagnostics, type V2Session, type V2Turn } from './session';
import { SKIPPED_PERSONA_TURN } from './turn-control';
import { deriveStateProposals } from './state-review';

export type EnginePhase = 'resolve' | 'context' | 'generate' | 'validate' | 'commit';
export class V2DraftRejected extends Error {
  constructor(message: string, readonly diagnostics: V2Diagnostics) { super(message); }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const V3_LEGACY_PROTOCOL_BLOCKS = [
  /\[RECENT EXCHANGE \/ NOT ENGINE AUTHORITY\][\s\S]*?\[END RECENT EXCHANGE\]/gi,
  /\[PLAYER TURN\][\s\S]*?\[WORLD RENDER \/ PLAYER-VISIBLE PROSE\]/gi,
  /\[PLAYER TURN\][\s\S]*?\[END PLAYER TURN\]/gi,
];
const V3_LEGACY_PROTOCOL_MARKERS = [
  /\[(?:PLAYER TURN|END PLAYER TURN|ASSISTANT TURN|END ASSISTANT TURN|END TURN|END RESPONSE|END ASSISTANT RESPONSE|WORLD RENDER \/ PLAYER-VISIBLE PROSE|IN-WORLD RESPONSE|END RECENT EXCHANGE|SYSTEM|NARRATOR)\]/gi,
];

export function stripV3ProtocolArtifacts(text: string) {
  let cleaned = text;
  for (const pattern of V3_LEGACY_PROTOCOL_BLOCKS) cleaned = cleaned.replace(pattern, '');
  for (const pattern of V3_LEGACY_PROTOCOL_MARKERS) cleaned = cleaned.replace(pattern, '');
  return cleaned
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:END\s+)?(?:PLAYER|USER|ASSISTANT|SYSTEM|NARRATOR)\s+TURN\s*:?\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeActionChunk(value: string) {
  if (!value.trim()) return value;
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const end = Math.max(leading.length, value.length - trailing.length);
  const core = value.slice(leading.length, end).replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim();
  return core ? `${leading}*${core}*${trailing}` : value;
}

export function decodeV2SerializedRoleplayArtifacts(text: string) {
  const escapedNewlines = text.match(/\\+n/g)?.length ?? 0;
  const escapedMarkup = (text.match(/\\+"/g)?.length ?? 0)
    + (text.match(/\\+\*/g)?.length ?? 0)
    + (text.match(/\\+\[/g)?.length ?? 0)
    + (text.match(/\\+\]/g)?.length ?? 0);
  if (escapedNewlines === 0 || escapedMarkup < 2) return text;
  return text
    .replace(/\\+r\\+n/g, '\n')
    .replace(/\\+n/g, '\n')
    .replace(/\\+"/g, '"')
    .replace(/\\+\*/g, '*')
    .replace(/\\+\[/g, '[')
    .replace(/\\+\]/g, ']');
}

export function normalizeV2RoleplayFormat(text: string) {
  const dialogueUnwrapped = text.trim()
    .replace(/(^|\s)\*+(?=["“])/g, '$1')
    .replace(/(["”])\*+(?=$|\s)/g, '$1');
  const cleaned = dialogueUnwrapped.replace(/\*("[^"\n]*"|“[^”\n]*”)\*/g, '$1');
  return cleaned.split(/(\[[^\]\n]+\]|"[^"\n]*"|“[^”\n]*”)/g).map((part) => {
    if (!part) return '';
    if ((part.startsWith('[') && part.endsWith(']'))
      || (part.startsWith('"') && part.endsWith('"'))
      || (part.startsWith('“') && part.endsWith('”'))) return part;
    return part.split('\n').map(normalizeActionChunk).join('\n');
  }).join('').trim();
}

export function validateV2Reply(text: string, playerName = '') {
  const issues: string[] = [];
  if (!text.trim()) issues.push('The model returned an empty reply.');
  if (text.length > 64000) issues.push('The reply exceeds the safe transport size.');
  if (/<\|(?:user|assistant|system|im_start|im_end)\|>|<\/?(?:world_state|state_patch|analysis)>/i.test(text)) {
    issues.push('The draft exposes control tokens or a state patch.');
  }
  if (/^\s*(?:PLAYER|USER|SYSTEM|ENGINE STATE|VALIDATION RESULTS)\s*:/im.test(text)) {
    issues.push('The draft contains an unauthorized player or engine section.');
  }
  if (playerName.trim() && new RegExp(`^\\s*${escapeRegExp(playerName.trim())}\\s*:`, 'im').test(text)) {
    issues.push('The draft writes a speaker turn for the player persona.');
  }
  return issues;
}

export async function generateV2Turn(session: V2Session, provider: ProviderAdapter, options: {
  reroll?: boolean; skipPersona?: boolean; signal?: AbortSignal; onPhase?: (phase: EnginePhase) => void; now?: number;
} = {}): Promise<V2Session> {
  const settings = settingsSchema.parse(session.settings);
  if (options.signal?.aborted) throw new Error('Generation cancelled. No provider call was made.');
  if (session.launch.expiresAt <= Date.now()) throw new Error('V3 authorization expired. Relaunch from Orbis, then import your V3/V2-compatible export.');
  const originalLast = session.turns.at(-1);
  const workingSession = options.reroll && originalLast ? rollbackTurnOwnedActions(session, originalLast.id) : session;
  const last = workingSession.turns.at(-1);
  if (options.reroll && (!last || last.worldRevision !== workingSession.world.revision)) {
    throw new Error('Reroll requires the latest turn and its unchanged world state.');
  }
  const skipPersona = options.reroll ? last!.player === SKIPPED_PERSONA_TURN : options.skipPersona === true;
  const player = skipPersona ? SKIPPED_PERSONA_TURN : (options.reroll ? last!.player : workingSession.draft).trim();
  if (!skipPersona && (!player || player.length > 16000)) throw new Error('Write a player turn between 1 and 16000 characters.');
  const characterPrimary = Boolean(workingSession.launch.character && workingSession.launch.primaryAsset.type === 'character');
  const relationshipBase = options.reroll && characterPrimary
    ? removeRelationshipTurns(workingSession.relationships, workingSession.launch.character!.id, workingSession.launch.persona.id, [last!.id])
    : workingSession.relationships;
  const base = options.reroll
    ? { ...workingSession, turns: workingSession.turns.slice(0, -1), relationships: relationshipBase }
    : { ...workingSession, relationships: relationshipBase };
  const id = options.reroll ? last!.id : `v3:${workingSession.id}:${workingSession.nextTurn}`;
  const relationshipBefore = characterPrimary
    ? getRelationship(relationshipBase, workingSession.launch.character!.id, workingSession.launch.persona.id)
    : null;

  options.onPhase?.('resolve');
  const resolved = resolveV2PlayerTurn(base, player, { skipPersona, reroll: options.reroll });
  const resolvedSession = resolved.session;

  options.onPhase?.('context');
  const compiled = compileV2Context(resolvedSession, player, skipPersona ? 'skip-persona' : 'normal', resolved.resolution);
  options.onPhase?.('generate');
  const result = await provider.generate({
    prompt: compiled.prompt, model: workingSession.launch.model,
    temperature: settings.temperature, maxTokens: settings.maxTokens, topK: settings.topK, topP: settings.topP,
    presencePenalty: settings.presencePenalty, frequencyPenalty: settings.frequencyPenalty,
    stopSequences: [...settings.stopSequences],
    continueToEndOfSentence: settings.continueToEndOfSentence, reroll: options.reroll, signal: options.signal,
  });
  if (options.signal?.aborted) throw new Error('Generation cancelled. No turn or state was committed.');
  options.onPhase?.('validate');
  const rawReply = result.text.trim();
  const rawIssues = validateV2Reply(rawReply, workingSession.launch.persona.name);
  const decodedReply = decodeV2SerializedRoleplayArtifacts(rawReply);
  const sanitizedReply = stripV3ProtocolArtifacts(decodedReply);
  const decodedIssues = validateV2Reply(sanitizedReply, workingSession.launch.persona.name);
  const canNormalize = result.metadata.completionStatus !== 'max_tokens' && rawIssues.length === 0 && decodedIssues.length === 0;
  const normalizedReply = canNormalize ? normalizeV2RoleplayFormat(sanitizedReply) : sanitizedReply;
  const issues = [...new Set([...rawIssues, ...decodedIssues, ...validateV2Reply(normalizedReply, workingSession.launch.persona.name)])];
  if (result.metadata.completionStatus === 'max_tokens') {
    issues.push('The provider reached the hard output ceiling. The cut-off reply was discarded instead of being committed.');
  }
  const warnings = ['Semantic canon claim validation is not complete. Generated prose remains downstream of and non-authoritative over physical state.'];
  if (resolved.resolution.deferredClaims.length) warnings.push(...resolved.resolution.deferredClaims);
  if (skipPersona) warnings.push('The player persona turn was explicitly skipped. The renderer was forbidden from inventing a player action or decision.');
  if (options.reroll) warnings.push('Reroll reused the already-resolved world state. Elapsed time and narrative dice were not rolled or committed twice.');
  if (decodedReply !== rawReply) warnings.push('Serialized roleplay escape sequences were decoded before commit.');
  if (sanitizedReply !== decodedReply) warnings.push('Legacy Speculus turn/control markers were stripped before commit.');
  if (canNormalize && normalizedReply !== sanitizedReply) warnings.push('Roleplay formatting was normalized before commit so narration/action, dialogue and inner voice remain structurally distinct.');
  if (compiled.omitted.length) warnings.push('Some history/canon was omitted. Inspect the Context tab for the exact list.');
  const at = options.now ?? Date.now();
  let relationships = relationshipBase;
  let relationshipAfter = relationshipBefore;
  let relationshipEvent = null;
  if (characterPrimary && relationshipBefore && !skipPersona) {
    const evaluation = heuristicRelationshipScorer.evaluate({
      playerMessage: player,
      characterReply: normalizedReply,
      previousScore: relationshipBefore.score,
    });
    const hasRelationshipChange = evaluation.delta !== 0 || Object.keys(evaluation.dimensionDeltas).length > 0;
    if (hasRelationshipChange) {
      relationships = commitRelationshipEvent(relationshipBase, {
        characterId: workingSession.launch.character!.id,
        personaId: workingSession.launch.persona.id,
        turnId: id,
        delta: evaluation.delta,
        reason: evaluation.reason,
        dimensionDeltas: evaluation.dimensionDeltas,
        createdAt: at,
      });
      relationshipAfter = getRelationship(relationships, workingSession.launch.character!.id, workingSession.launch.persona.id);
      relationshipEvent = relationshipAfter.events.find((event) => event.turnId === id) ?? null;
      if (relationshipEvent) warnings.push(`Relationship state updated: ${relationshipEvent.reason}`);
    }
  }
  const diagnostics: V2Diagnostics = {
    prompt: compiled.prompt, included: compiled.included, omitted: compiled.omitted,
    estimatedInputTokens: compiled.estimatedInputTokens, outputBudget: compiled.outputBudget,
    issues, warnings, model: workingSession.launch.model, durationMs: result.metadata.durationMs,
    completionStatus: result.metadata.completionStatus ?? 'unknown', worldRevision: resolvedSession.world.revision,
    viewpointActorId: resolved.resolution.playerActorId,
    subjectActorId: resolved.resolution.subjectActorId,
    resolutionStatus: resolved.resolution.status,
    resolutionDeferredClaims: [...resolved.resolution.deferredClaims],
    resolutionElapsedSeconds: resolved.resolution.elapsedSeconds,
    resolutionCheck: resolved.resolution.narrativeCheck,
    providerKind: result.metadata.provider, providerEndpoint: result.metadata.endpoint, requestId: result.metadata.requestId,
    finishReason: result.metadata.finishReason, requestedMaxTokens: result.metadata.requestedMaxTokens,
    providerInputTokensEstimate: result.metadata.inputTokensEstimate,
    generationSettings: {
      output: settings.output, maxTokens: settings.maxTokens, temperature: settings.temperature,
      topK: settings.topK, topP: settings.topP, presencePenalty: settings.presencePenalty,
      frequencyPenalty: settings.frequencyPenalty, stopSequences: [...settings.stopSequences],
      continueToEndOfSentence: settings.continueToEndOfSentence,
    },
  };
  if (issues.length) throw new V2DraftRejected(`Draft rejected: ${issues.join(' ')}`, diagnostics);
  const turn: V2Turn = { id, player, reply: normalizedReply, createdAt: options.reroll ? last!.createdAt : at, worldRevision: resolvedSession.world.revision, diagnostics };
  options.onPhase?.('commit');
  const resolutionEvent = !options.reroll && resolvedSession.world.revision !== base.world.revision
    ? {
      id: `${id}:resolution`, kind: 'operator' as const,
      label: resolved.resolution.appliedActions.join(', ').slice(0, 200) || 'turn-resolution',
      worldRevision: resolvedSession.world.revision, at, world: resolvedSession.world, ownerTurnId: null,
    }
    : null;
  const proposalBase = workingSession.stateProposals.filter((proposal) => proposal.sourceTurnId !== id);
  const stateProposals = [
    ...proposalBase,
    ...deriveStateProposals({ ...resolvedSession, relationships, stateProposals: proposalBase }, id, normalizedReply),
  ];

  return {
    ...resolvedSession, draft: options.reroll || skipPersona ? workingSession.draft : '', turns: [...resolvedSession.turns, turn],
    nextTurn: workingSession.nextTurn + (options.reroll ? 0 : 1),
    relationships,
    stateProposals,
    events: options.reroll
      ? workingSession.events.map((event) => event.id === id ? { ...event, label: skipPersona ? 'Reply rerolled / persona skipped' : 'Reply rerolled', at } : event)
      : [...resolvedSession.events, ...(resolutionEvent ? [resolutionEvent] : []), { id, kind: 'turn', label: skipPersona ? 'Reply committed / persona skipped' : 'Reply committed', worldRevision: resolvedSession.world.revision, at, ownerTurnId: null }],
  };
}
