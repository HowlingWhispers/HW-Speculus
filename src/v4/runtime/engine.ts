import type { ProviderAdapter, ProviderResult } from '../../runtime/providers/types';
import { commitRelationshipEvent, getRelationship, removeRelationshipTurns } from '../../runtime/relationships/core';
import { heuristicRelationshipScorer } from '../../runtime/relationships/evaluator';
import { compileV4Context } from './context';
import { resolveV4PlayerTurn, type V4TurnResolution } from './resolution';
import { rollbackTurnOwnedActions, settingsSchema, type V4Diagnostics, type V4Session, type V4Turn } from './session';
import { SKIPPED_PERSONA_TURN, isSkippedPersonaTurn, skippedPersonaActorId, skippedPersonaTurnAs } from './turn-control';
import { deriveStateProposals } from './state-review';
import { approximateV4OutputTokens, countV4Paragraphs, normalizeV4Paragraphs } from './paragraphs';
import { detectV4ProseSlop, needsV4ProseRepair } from './prose-quality';
import { resolutionSchema, sameState } from './boundaries';
import { assertWorldCanon } from './world';
import { assertV4NotCancelled, generateV4Output } from './generation';

export type EnginePhase = 'resolve' | 'context' | 'generate' | 'validate' | 'commit';
export class V4DraftRejected extends Error {
  constructor(message: string, readonly diagnostics: V4Diagnostics) { super(message); }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const V4_LEGACY_PROTOCOL_BLOCKS = [
  /\[RECENT EXCHANGE \/ NOT ENGINE AUTHORITY\][\s\S]*?\[END RECENT EXCHANGE\]/gi,
  /\[PLAYER TURN\][\s\S]*?\[WORLD RENDER \/ PLAYER-VISIBLE PROSE\]/gi,
  /\[PLAYER TURN\][\s\S]*?\[END PLAYER TURN\]/gi,
];
const V4_LEGACY_PROTOCOL_MARKERS = [
  /\[(?:PLAYER TURN|END PLAYER TURN|ASSISTANT TURN|END ASSISTANT TURN|END TURN|END RESPONSE|END ASSISTANT RESPONSE|WORLD RENDER \/ PLAYER-VISIBLE PROSE|IN-WORLD RESPONSE|END RECENT EXCHANGE|SYSTEM|NARRATOR)\]/gi,
];

export function stripV4ProtocolArtifacts(text: string) {
  let cleaned = text;
  for (const pattern of V4_LEGACY_PROTOCOL_BLOCKS) cleaned = cleaned.replace(pattern, '');
  for (const pattern of V4_LEGACY_PROTOCOL_MARKERS) cleaned = cleaned.replace(pattern, '');
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

export function decodeV4SerializedRoleplayArtifacts(text: string) {
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

export function normalizeV4RoleplayFormat(text: string) {
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

export function validateV4Reply(text: string, playerName = '') {
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

export type V4GenerationOptions = {
  reroll?: boolean; skipPersona?: boolean; skipAsActorId?: string; signal?: AbortSignal; onPhase?: (phase: EnginePhase) => void; now?: number;
  turnId?: string;
  pageId?: string;
  editedReply?: string;
  recordedResolution?: { resolution: V4TurnResolution; resolvedSession: V4Session };
  onCheckpoints?: (checkpoints: { before: V4Session; resolved: V4Session; after: V4Session; resolution: V4TurnResolution }) => void;
};

export async function generateV4Turn(session: V4Session, provider: ProviderAdapter, options: V4GenerationOptions = {}): Promise<V4Session> {
  const settings = settingsSchema.parse(session.settings);
  if (options.signal?.aborted) throw new Error('Generation cancelled. No provider call was made.');
  const localRecordedReplyEdit = options.editedReply !== undefined && options.recordedResolution !== undefined && !options.reroll;
  if (session.launch.expiresAt <= Date.now() && !localRecordedReplyEdit) throw new Error('V4 authorization expired. Relaunch from Orbis, then import your V4 or compatible V3 export.');
  const originalLast = session.turns.at(-1);
  const workingSession = options.reroll && originalLast ? rollbackTurnOwnedActions(session, originalLast.id) : session;
  const last = workingSession.turns.at(-1);
  if (options.reroll && (!last || last.worldRevision !== workingSession.world.revision)) {
    throw new Error('Reroll requires the latest turn and its unchanged world state.');
  }
  const requestedSkipActorId = options.skipAsActorId?.trim() || null;
  const skipAsActorId = options.reroll ? skippedPersonaActorId(last?.player ?? '') : requestedSkipActorId;
  const skipPersona = options.reroll ? isSkippedPersonaTurn(last?.player ?? '') : options.skipPersona === true || skipAsActorId !== null;
  if (skipAsActorId && !workingSession.world.actors.some((actor) => actor.id === skipAsActorId && actor.role === 'character')) {
    throw new Error('Skip as requires a packaged NPC actor.');
  }
  const player = skipPersona
    ? skipAsActorId ? skippedPersonaTurnAs(skipAsActorId) : SKIPPED_PERSONA_TURN
    : (options.reroll ? last!.player : workingSession.draft).trim();
  if (!skipPersona && (!player || player.length > 16000)) throw new Error('Write a player turn between 1 and 16000 characters.');
  const characterPrimary = Boolean(workingSession.launch.character && workingSession.launch.primaryAsset.type === 'character');
  const relationshipBase = options.reroll && characterPrimary
    ? removeRelationshipTurns(workingSession.relationships, workingSession.launch.character!.id, workingSession.launch.persona.id, [last!.id])
    : workingSession.relationships;
  const base = options.reroll
    ? { ...workingSession, turns: workingSession.turns.slice(0, -1), relationships: relationshipBase }
    : { ...workingSession, relationships: relationshipBase };
  const id = options.reroll ? last!.id : options.turnId ?? `v4:${crypto.randomUUID()}`;
  if (!options.reroll && workingSession.turns.some((turn) => turn.id === id)) throw new Error('Turn identity already exists.');
  const relationshipBefore = characterPrimary
    ? getRelationship(relationshipBase, workingSession.launch.character!.id, workingSession.launch.persona.id)
    : null;

  options.onPhase?.('resolve');
  if (options.signal?.aborted) throw new Error('Generation cancelled. No turn or state was committed.');
  const resolved = options.recordedResolution
    ? { session: structuredClone(options.recordedResolution.resolvedSession), resolution: resolutionSchema.parse(options.recordedResolution.resolution) }
    : resolveV4PlayerTurn(base, player, { skipPersona, reroll: options.reroll });
  if (resolved.session.id !== base.id || resolved.resolution.worldRevisionAfter !== resolved.session.world.revision
    || (options.recordedResolution && (resolved.resolution.worldRevisionBefore !== base.world.revision
      || !sameState({ ...resolved.session, world: base.world }, base)))) {
    throw new Error('Recorded resolution does not match the generation boundary.');
  }
  assertWorldCanon(resolved.session.world, base.launch);
  const resolvedSession = resolved.session;

  options.onPhase?.('context');
  const compiled = compileV4Context(resolvedSession, player, skipPersona ? 'skip-persona' : 'normal', resolved.resolution);
  options.onPhase?.('generate');
  if (options.signal?.aborted) throw new Error('Generation cancelled. No provider call was made.');
  const generated = options.editedReply !== undefined ? null : await generateV4Output(provider, {
    prompt: compiled.prompt, model: workingSession.launch.model,
    temperature: settings.temperature, maxTokens: compiled.outputBudget, topK: settings.topK, topP: settings.topP,
    presencePenalty: settings.presencePenalty, frequencyPenalty: settings.frequencyPenalty,
    stopSequences: [...settings.stopSequences],
    continueToEndOfSentence: settings.continueToEndOfSentence, reroll: options.reroll, signal: options.signal,
  }, compiled.outputContract, {
    inspect(raw) {
      const decoded = stripV4ProtocolArtifacts(decodeV4SerializedRoleplayArtifacts(raw.trim()));
      const issues = [...validateV4Reply(raw, workingSession.launch.persona.name), ...validateV4Reply(decoded, workingSession.launch.persona.name)];
      if (issues.length) throw new Error(issues.join(' '));
      return decoded;
    },
  });
  const result: ProviderResult = generated?.result ?? {
    text: options.editedReply ?? '', metadata: { provider: provider.kind, model: workingSession.launch.model, endpoint: 'local-reply-edit', durationMs: 0, completionStatus: 'completed' },
  };
  if (options.signal?.aborted) throw new Error('Generation cancelled. No turn or state was committed.');
  options.onPhase?.('validate');
  assertV4NotCancelled(options.signal);
  const rawReply = result.text.trim();
  const rawIssues = validateV4Reply(rawReply, workingSession.launch.persona.name);
  const decodedReply = decodeV4SerializedRoleplayArtifacts(rawReply);
  const sanitizedReply = stripV4ProtocolArtifacts(decodedReply);
  const decodedIssues = validateV4Reply(sanitizedReply, workingSession.launch.persona.name);
  const canNormalize = result.metadata.completionStatus !== 'max_tokens' && rawIssues.length === 0 && decodedIssues.length === 0;
  const roleplayNormalized = canNormalize && !generated ? normalizeV4RoleplayFormat(sanitizedReply) : sanitizedReply;
  // Conservative readability pass. Only inserts paragraph breaks; never rewords.
  const paragraphPass = canNormalize
    ? normalizeV4Paragraphs(roleplayNormalized)
    : { text: roleplayNormalized, applied: false, paragraphs: countV4Paragraphs(roleplayNormalized), splitParagraphs: 0 };
  const normalizedReply = paragraphPass.text;
  const issues = [...new Set([...rawIssues, ...decodedIssues, ...validateV4Reply(normalizedReply, workingSession.launch.persona.name)])];
  if (result.metadata.completionStatus === 'max_tokens') {
    issues.push('The provider reached the hard output ceiling. The cut-off reply was discarded instead of being committed.');
  }
  const warnings = ['Semantic canon claim validation is not complete. Generated prose remains downstream of and non-authoritative over physical state.'];
  const remainingSlopHits = detectV4ProseSlop(normalizedReply);
  if (needsV4ProseRepair(remainingSlopHits)) {
    warnings.push(`The draft contains structural prose repetition (${remainingSlopHits.map((hit) => hit.label).join(', ')}); this is advisory only and no style rewrite was attempted.`);
  }
  if (resolved.resolution.deferredClaims.length) warnings.push(...resolved.resolution.deferredClaims);
  if (skipPersona) {
    const skippedActorName = skipAsActorId
      ? workingSession.world.actors.find((actor) => actor.id === skipAsActorId)?.name ?? skipAsActorId
      : null;
    warnings.push(skippedActorName
      ? `The player persona turn was explicitly skipped as ${skippedActorName}. The renderer was limited to that NPC's immediate beat and forbidden from inventing a player action or decision.`
      : 'The player persona turn was explicitly skipped. The renderer was forbidden from inventing a player action or decision.');
  }
  if (options.reroll) warnings.push('Reroll reused the already-resolved world state. Elapsed time and narrative dice were not rolled or committed twice.');
  else if (options.recordedResolution) warnings.push('This history page reused the recorded trusted resolution. Elapsed time and narrative dice were not rolled twice.');
  if (options.editedReply !== undefined) warnings.push('Reply-only edit was structurally validated and normalized locally. Relationship effects and proposals were recomputed; prose did not author physical state.');
  if (decodedReply !== rawReply) warnings.push('Serialized roleplay escape sequences were decoded before commit.');
  if (sanitizedReply !== decodedReply) warnings.push('Legacy Speculus turn/control markers were stripped before commit.');
  if (canNormalize && roleplayNormalized !== sanitizedReply) warnings.push('Roleplay formatting was normalized before commit so narration/action, dialogue and inner voice remain structurally distinct.');
  if (paragraphPass.applied) warnings.push(`Paragraph readability pass inserted ${paragraphPass.splitParagraphs} paragraph break(s). Wording was not changed.`);
  if (generated) warnings.push(`V4 generation used ${generated.attempts} upstream attempt(s)${generated.reason ? `; one repair for ${generated.reason}` : '; no repair'}.`);
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
  const approximateOutputTokens = approximateV4OutputTokens(normalizedReply);
  const outputCompliance = {
    preset: compiled.outputContract.preset,
    ceilingTokens: compiled.outputContract.ceilingTokens,
    targetMinTokens: compiled.outputContract.targetMinTokens,
    targetMaxTokens: compiled.outputContract.targetMaxTokens,
    approximateOutputTokens,
    paragraphCount: paragraphPass.paragraphs,
    paragraphNormalizationApplied: paragraphPass.applied,
    splitParagraphs: paragraphPass.splitParagraphs,
    band: approximateOutputTokens < compiled.outputContract.targetMinTokens
      ? 'under-target' as const
      : approximateOutputTokens > compiled.outputContract.targetMaxTokens
        ? 'over-target' as const
        : 'within-target' as const,
  };
  // Marathons frequently stop far too early. maxTokens alone cannot detect that,
  // so flag a hard-stop that landed well under the requested depth.
  const stoppedExtremelyEarly = approximateOutputTokens < Math.floor(compiled.outputContract.targetMinTokens * 0.5);
  if (outputCompliance.preset === 'short' && outputCompliance.band === 'over-target') {
    warnings.push(`Short preset targeted ${compiled.outputContract.targetMinTokens}-${compiled.outputContract.targetMaxTokens} tokens, but the provider returned roughly ${approximateOutputTokens}. This is advisory only; no length rewrite was attempted.`);
  }
  if (outputCompliance.preset === 'marathon' && stoppedExtremelyEarly) {
    warnings.push(`Marathon requested ${compiled.outputContract.targetMinTokens}-${compiled.outputContract.targetMaxTokens} tokens but the provider produced roughly ${approximateOutputTokens}. The provider stopped early; generated text was not padded and no extra scene progression was invented.`);
  }
  if (compiled.continuity.latestTurnMissingFromContext) {
    warnings.push(`CRITICAL continuity failure: latest committed turn ${compiled.continuity.latestCommittedTurnId} was absent from renderer context.`);
  }
  const diagnostics: V4Diagnostics = {
    prompt: compiled.prompt, included: compiled.included, omitted: compiled.omitted,
    outputCompliance: {
      ...outputCompliance,
      stoppedExtremelyEarly,
      stoppedExtremelyEarlyForMarathon: outputCompliance.preset === 'marathon' ? stoppedExtremelyEarly : undefined,
    },
    continuity: compiled.continuity,
    estimatedInputTokens: compiled.estimatedInputTokens, outputBudget: compiled.outputBudget,
    issues, warnings, model: workingSession.launch.model, durationMs: result.metadata.durationMs,
    completionStatus: result.metadata.completionStatus ?? 'unknown', worldRevision: resolvedSession.world.revision,
    viewpointActorId: resolved.resolution.playerActorId,
    subjectActorId: skipAsActorId ?? resolved.resolution.subjectActorId,
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
  if (issues.length) throw new V4DraftRejected(`Draft rejected: ${issues.join(' ')}`, diagnostics);
  const turn: V4Turn = { id, player, reply: normalizedReply, createdAt: options.reroll ? last!.createdAt : at, worldRevision: resolvedSession.world.revision, diagnostics };
  options.onPhase?.('commit');
  if (options.signal?.aborted) throw new Error('Generation cancelled. No turn or state was committed.');
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
    ...deriveStateProposals({ ...resolvedSession, relationships, stateProposals: proposalBase }, id, normalizedReply).map((proposal) => options.pageId ? {
      ...proposal, id: `proposal:${options.pageId}:${proposal.id.slice(`proposal:${id}:`.length)}`, sourcePageId: options.pageId,
    } : proposal),
  ];

  const committed: V4Session = {
    ...resolvedSession, draft: options.reroll || skipPersona ? workingSession.draft : '', turns: [...resolvedSession.turns, turn],
    nextTurn: workingSession.nextTurn + (options.reroll ? 0 : 1),
    relationships,
    stateProposals,
    events: options.reroll
      ? workingSession.events.map((event) => event.id === id ? {
        ...event,
        label: skipAsActorId
          ? `Reply rerolled / skipped as ${workingSession.world.actors.find((actor) => actor.id === skipAsActorId)?.name ?? skipAsActorId}`
          : skipPersona ? 'Reply rerolled / persona skipped' : 'Reply rerolled',
        at,
      } : event)
      : [...resolvedSession.events, ...(resolutionEvent ? [resolutionEvent] : []), {
        id,
        kind: 'turn',
        label: skipAsActorId
          ? `Reply committed / skipped as ${workingSession.world.actors.find((actor) => actor.id === skipAsActorId)?.name ?? skipAsActorId}`
          : skipPersona ? 'Reply committed / persona skipped' : 'Reply committed',
        worldRevision: resolvedSession.world.revision,
        at,
        ownerTurnId: null,
      }],
  };
  options.onCheckpoints?.(structuredClone({ before: base, resolved: resolvedSession, after: committed, resolution: resolved.resolution }));
  assertV4NotCancelled(options.signal);
  return committed;
}
