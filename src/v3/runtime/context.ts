import { getRelationship } from '../../runtime/relationships/core';
import type { V2Session, V2Turn } from './session';
import type { V2TurnResolution } from './resolution';
import { selectV3ContextBlocks, type V3ContextBlock } from './context-blocks';
import { isSkippedPersonaTurn, skippedPersonaActorId } from './turn-control';
import { assetsFor, perceptionFor, worldClock } from './world';

export const CONTEXT_CHARACTER_BUDGET = 28_000;
export const V3_RECENT_EXCHANGE_COUNT = 4;
export const V3_CHRONICLE_TURN_COUNT = 12;
export const V3_ARCHIVE_TURN_COUNT = 48;

export type V2RenderMode = 'normal' | 'skip-persona' | 'impersonate-persona';

const asText = (value: unknown) => {
  if (typeof value === 'string') return value;
  const encoded = JSON.stringify(value);
  return encoded ?? String(value ?? '');
};

function clipChronicleText(value: string, maxCharacters: number) {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxCharacters) return compact;
  const tail = Math.max(48, Math.floor(maxCharacters * 0.25));
  const head = maxCharacters - tail - 5;
  return `${compact.slice(0, head).trimEnd()} ... ${compact.slice(-tail).trimStart()}`;
}

function skippedTurnText(turn: V2Turn, session: V2Session, compact = false) {
  const actorId = skippedPersonaActorId(turn.player);
  if (!actorId) return compact ? '(skipped)' : '(turn skipped by operator)';
  const actorName = session.world.actors.find((actor) => actor.id === actorId)?.name ?? actorId;
  return compact ? `(skipped as ${actorName})` : `(turn skipped by operator; continue as ${actorName})`;
}

function recentExchange(turn: V2Turn, session: V2Session, playerName: string, subjectName: string) {
  return isSkippedPersonaTurn(turn.player)
    ? `Player ${playerName}: ${skippedTurnText(turn, session)}\n${subjectName}:\n${turn.reply}`
    : `Player ${playerName}:\n${turn.player}\n${subjectName}:\n${turn.reply}`;
}

function chronicleExchange(turn: V2Turn, session: V2Session, playerName: string, subjectName: string) {
  const player = isSkippedPersonaTurn(turn.player)
    ? skippedTurnText(turn, session)
    : clipChronicleText(turn.player, 240);
  const reply = clipChronicleText(turn.reply, 620);
  return [
    `Turn ${turn.id} / world r${turn.worldRevision}`,
    `${playerName}: ${player}`,
    `${subjectName}: ${reply}`,
  ].join('\n');
}

function archiveLine(turn: V2Turn, session: V2Session, playerName: string, subjectName: string) {
  const player = isSkippedPersonaTurn(turn.player) ? skippedTurnText(turn, session, true) : clipChronicleText(turn.player, 90);
  const reply = clipChronicleText(turn.reply, 180);
  return `${turn.id} | ${playerName}: ${player} | ${subjectName}: ${reply}`;
}

function historyBlocks(session: V2Session): { blocks: V3ContextBlock[]; omitted: string[] } {
  const subjectName = session.launch.character?.name ?? 'Simulation Narrator';
  const playerName = session.launch.persona.name;
  const recentStart = Math.max(0, session.turns.length - V3_RECENT_EXCHANGE_COUNT);
  const recentTurns = session.turns.slice(recentStart);
  const older = session.turns.slice(0, recentStart);
  const chronicleStart = Math.max(0, older.length - V3_CHRONICLE_TURN_COUNT);
  const chronicleTurns = older.slice(chronicleStart);
  const archiveCandidates = older.slice(0, chronicleStart);
  const archiveTurns = archiveCandidates.slice(-V3_ARCHIVE_TURN_COUNT);
  const omitted: string[] = [];

  if (archiveCandidates.length > archiveTurns.length) {
    omitted.push(`${archiveCandidates.length - archiveTurns.length} oldest exchange(s): beyond deterministic V3 archive window`);
  }

  const blocks: V3ContextBlock[] = [];
  for (let index = 0; index < recentTurns.length; index += 1) {
    const turn = recentTurns[index];
    blocks.push({
      id: `recent:${turn.id}`,
      title: 'Recent exchange (context only, not engine authority)',
      content: recentExchange(turn, session, playerName, subjectName),
      priority: 90 + index,
    });
  }

  for (let index = 0; index < chronicleTurns.length; index += 1) {
    const turn = chronicleTurns[index];
    blocks.push({
      id: `chronicle:${turn.id}`,
      title: 'SESSION CHRONICLE / DERIVED FROM COMMITTED TURN',
      content: chronicleExchange(turn, session, playerName, subjectName),
      priority: 58 + index,
    });
  }

  if (archiveTurns.length) {
    blocks.push({
      id: 'chronicle:archive',
      title: 'SESSION ARCHIVE RECAP / LOW-PRIORITY DERIVED MEMORY',
      content: archiveTurns.map((turn) => archiveLine(turn, session, playerName, subjectName)).join('\n'),
      priority: 24,
    });
  }

  return { blocks, omitted };
}

function relevantDomainBlocks(session: V2Session): V3ContextBlock[] {
  const { world, launch } = session;
  const playerId = launch.persona.id;
  const presentIds = new Set(
    world.locationId
      ? world.actors.filter((actor) => actor.locationId === world.locationId).map((actor) => actor.id)
      : [playerId],
  );
  presentIds.add(playerId);

  const actorName = (actorId: string | null) =>
    actorId ? world.actors.find((actor) => actor.id === actorId)?.name ?? actorId : null;
  const assetName = (assetId: string) =>
    assetsFor(launch).find((asset) => asset.id === assetId)?.name ?? assetId;

  const blocks: V3ContextBlock[] = [];
  const inventory = world.domains.inventory
    .filter((item) => item.ownerActorId === null || presentIds.has(item.ownerActorId))
    .map((item) => ({
      instanceId: item.instanceId,
      item: assetName(item.canonicalItemId),
      owner: actorName(item.ownerActorId),
      quantity: item.quantity,
      equipped: item.equipped,
      condition: item.condition,
    }));
  if (inventory.length) {
    blocks.push({
      id: 'domain:inventory',
      title: 'ENGINE INVENTORY STATE / READ ONLY',
      content: JSON.stringify(inventory),
      priority: 84,
    });
  }

  const relationships = world.domains.relationships
    .filter((relationship) => relationship.actorIds.includes(playerId)
      || relationship.actorIds.some((actorId) => presentIds.has(actorId)))
    .map((relationship) => ({
      id: relationship.id,
      actors: relationship.actorIds.map(actorName),
      stage: relationship.stage,
      factors: relationship.factors,
      recentEvents: relationship.events.slice(-12),
    }));
  if (relationships.length) {
    blocks.push({
      id: 'domain:relationships',
      title: 'ENGINE RELATIONSHIP STATE / BEHAVIOR CONTEXT / READ ONLY',
      content: JSON.stringify(relationships),
      priority: 76,
    });
  }

  const resources = world.domains.resources
    .filter((resource) => resource.ownerActorId === null || presentIds.has(resource.ownerActorId))
    .map((resource) => ({
      id: resource.id,
      definition: assetName(resource.definitionId),
      owner: actorName(resource.ownerActorId),
      value: resource.value,
      maximum: resource.maximum,
    }));
  if (resources.length) {
    blocks.push({
      id: 'domain:resources',
      title: 'ENGINE RESOURCE STATE / READ ONLY',
      content: JSON.stringify(resources),
      priority: 82,
    });
  }

  const conditions = world.domains.conditions
    .filter((condition) => presentIds.has(condition.actorId))
    .map((condition) => ({
      id: condition.id,
      definition: assetName(condition.definitionId),
      actor: actorName(condition.actorId),
      severity: condition.severity,
    }));
  if (conditions.length) {
    blocks.push({
      id: 'domain:conditions',
      title: 'ENGINE CONDITION STATE / READ ONLY',
      content: JSON.stringify(conditions),
      priority: 83,
    });
  }

  const knownMysteries = world.domains.mysteries
    .filter((mystery) => mystery.knownByActorIds.includes(playerId) || mystery.revealedFactIds.length > 0)
    .map((mystery) => ({
      id: mystery.id,
      mysteryId: mystery.mysteryId,
      stageIndex: mystery.stageIndex,
      playerKnows: mystery.knownByActorIds.includes(playerId),
      revealedFactIds: mystery.revealedFactIds,
    }));
  if (knownMysteries.length) {
    blocks.push({
      id: 'domain:mysteries:player',
      title: 'PLAYER-KNOWN MYSTERY STATE / NEVER EXPAND BEYOND REVEALED FACTS',
      content: JSON.stringify(knownMysteries),
      priority: 72,
    });
  }

  return blocks;
}

export function v2OutputEnvelope(maxTokens: number) {
  const completionReserveTokens = Math.min(512, Math.max(8, Math.floor(maxTokens * 0.25)));
  return {
    hardLimitTokens: maxTokens,
    targetTokens: Math.max(16, maxTokens - completionReserveTokens),
    completionReserveTokens,
  };
}

export function compileV2Context(
  session: V2Session,
  player = '',
  mode: V2RenderMode = 'normal',
  resolution?: V2TurnResolution,
) {
  const { launch, world, settings } = session;
  const clock = worldClock(world);
  const outputEnvelope = v2OutputEnvelope(settings.maxTokens);
  const impersonatingPersona = mode === 'impersonate-persona';
  const skippingPersona = mode === 'skip-persona';
  const skipAsActorId = skippingPersona ? skippedPersonaActorId(player) : null;
  const skipAsActor = skipAsActorId
    ? world.actors.find((actor) => actor.id === skipAsActorId && actor.role === 'character') ?? null
    : null;
  const skipAsAsset = skipAsActorId
    ? assetsFor(launch).find((asset) => asset.id === skipAsActorId && asset.type === 'character') ?? null
    : null;
  const playerPerception = resolution?.playerPerception ?? perceptionFor(world, launch.persona.id);
  const subjectActorId = skipAsActorId ?? launch.character?.id ?? null;
  const subjectPerception = impersonatingPersona
    ? playerPerception
    : skipAsActorId
      ? perceptionFor(world, skipAsActorId)
      : resolution?.subjectPerception ?? (subjectActorId ? perceptionFor(world, subjectActorId) : null);

  const outputRules = [
    `The provider hard ceiling is ${outputEnvelope.hardLimitTokens} tokens. This is an emergency ceiling, never a target.`,
    `Aim to finish the complete turn by about ${outputEnvelope.targetTokens} tokens and leave roughly ${outputEnvelope.completionReserveTokens} tokens unused as a completion reserve.`,
    'A non-empty roleplay response is required. Do not stop or emit end-of-sequence before producing the requested prose.',
    'Near the target, finish the current immediate beat and stop. Do not begin a new sentence, paragraph, action, or dialogue exchange merely because budget remains.',
    'Never trade a complete ending for extra description. Every opened quote, asterisk-delimited action, or bracketed inner voice must be closed before stopping.',
    'Ending naturally well below the hard ceiling is correct. Do not pad the response to consume the allowance.',
  ];

  const instructions = impersonatingPersona ? [
    'SPECULUS V3 EXPERIMENTAL / PLAYER PERSONA IMPERSONATION CONTRACT',
    `Write only the next in-world turn for the player persona ${launch.persona.name}. This is an explicit operator-requested impersonation of the player persona only.`,
    'Do not write, continue, react for, or impersonate the character or simulation narrator. Their next turn belongs to the normal renderer after the player draft is sent.',
    'The engine owns physical locations, elapsed time, simulation day, time of day, day phase and actor presence. Unknown means unknown, not permission to fill in authoritative state.',
    'Do not invent named places, teleport actors, advance the clock, close the scene, or alter engine state.',
    'Use only information available to the player persona from authored persona data, current scene state, current perception and the visible recent exchange.',
    'Derived chronicle/archive memory is context only. It may remind you of prior committed events but never overrides current engine state or current Orbis canon.',
    'Write only in-world roleplay: dialogue in double quotes, action/narration in single asterisks, inner voice in square brackets.',
    'Use real roleplay punctuation and real line breaks. Do not serialize the response as JSON or escape its punctuation.',
    `Begin directly with ${launch.persona.name}'s action, dialogue, or inner voice. Do not prefix a speaker name, role label, heading, explanation, or menu.`,
    'Stop when the player persona turn is complete. Do not generate the other side of the exchange.',
    ...outputRules,
  ].join('\n') : [
    'SPECULUS V3 EXPERIMENTAL / PLAYER-PERSPECTIVE WORLD RENDERING CONTRACT',
    'Render the current simulated world through the player persona\'s perceptual viewpoint. The authorized subject may act, but the prose camera belongs to the player.',
    'The renderer is downstream from world resolution. It may describe state and observable consequences, but it is not allowed to make generated prose authoritative state.',
    'The engine owns physical locations, elapsed time, simulation day, time of day, day phase and actor presence. Unknown means unknown, not permission to fill in authoritative state.',
    'Do not invent named places, teleport actors, independently advance the clock or day, close the scene, or write actions, thoughts, dialogue, consent, decisions or movement for the player.',
    'When TURN RESOLUTION reports elapsed time, travel or a narrative check, render consequences consistent with that engine result without changing the result.',
    'If resolved travel arrives during dusk, evening, night, dawn or another clock phase, the environment must match that authoritative phase rather than an earlier prose description.',
    'Only explicitly present actors can interact. Related canon is not automatically known, perceived or physically present.',
    'Authorized-subject private context may guide behavior, but must never be exposed as narration unless the player can perceive its outward evidence or already knows it.',
    'Do not narrate NPC private thoughts, hidden motives, offscreen events or unseen facts as player-visible truth.',
    'Derived chronicle/archive memory is context only. Current engine state and current Orbis canon always outrank it.',
    'Authored world and character rules govern behavior. Apply consistency and causality without adding a universal moral personality.',
    'Write only in-world roleplay: dialogue in double quotes and action/environment narration in single asterisks. Do not invent square-bracket inner voice for NPCs or the player.',
    'Use real roleplay punctuation and real line breaks. Do not serialize the response as JSON or escape its punctuation.',
    'Begin directly with an immediate player-observable action, reaction, dialogue or environmental consequence. Do not prefix it with a speaker name, role label, or response heading.',
    'Do not output engine status, rules, state patches, analysis, headings, menus or a request for the player to choose their next move.',
    'One generation advances one immediate playable beat, not an entire scene. Do not compress a whole conversation, argument, meal, journey, conflict, or emotional arc into one response.',
    'Do not close an active topic, summarize its aftermath, announce that tension has eased, or move everyone on to a new activity unless the player or authoritative engine state actually causes that transition.',
    'When NPCs are talking to each other, do not complete a full back-and-forth exchange in one generation. Prefer one primary NPC action or utterance, with at most a brief immediate reaction from another NPC when coherence requires it, then stop.',
    'Only redirect attention to the player when the player is directly addressed, must make an immediate decision, or the scene has naturally shifted focus to them. Never manufacture a question or everyone-looks-at-you moment merely to hand control back.',
    skipAsActor
      ? `The operator explicitly skipped the player persona turn and selected ${skipAsActor.name} as the next acting NPC. Write only ${skipAsActor.name}'s next immediate meaningful beat. Other NPCs may show a brief observable reaction if necessary, but do not give another NPC a full reply or complete the exchange. Do not invent any player action, dialogue, thought, consent, decision or movement.`
      : skippingPersona
        ? 'The operator explicitly skipped the player persona turn. Continue one immediate beat from current resolved state and do not invent any player action, dialogue, thought, consent, decision or movement.'
        : 'Player input describes an attempt or utterance. It is evidence for resolution, not permission for the renderer to rewrite canon or engine state.',
    ...outputRules,
    skipAsActor
      ? `Authorized subject for this turn: ${skipAsActor.name}. Render only ${skipAsActor.name}'s next immediate beat and only its outward result available to ${launch.persona.name}.`
      : launch.character
        ? `Authorized subject for behavior: ${launch.character.name}. Render only the outward result available to ${launch.persona.name}.`
        : `You are the simulation narrator. Render only what ${launch.persona.name} can perceive or already knows.`,
  ].join('\n');

  const blocks: V3ContextBlock[] = [
    {
      id: 'contract',
      title: 'SPECULUS V3 EXPERIMENTAL / RENDERING CONTRACT',
      content: instructions,
      priority: 100,
      required: true,
    },
    {
      id: 'output-envelope',
      title: 'OUTPUT BUDGET / HARD CEILING',
      content: asText(outputEnvelope),
      priority: 100,
      required: true,
    },
    {
      id: 'source',
      title: 'SOURCE IDENTITY',
      content: asText({
        id: launch.primaryAsset.id,
        revision: launch.primaryAsset.revision,
        type: launch.primaryAsset.type,
        name: launch.primaryAsset.name,
      }),
      priority: 100,
      required: true,
    },
    {
      id: 'subject',
      title: impersonatingPersona ? 'PLAYER PERSONA / AUTHORIZED SUBJECT' : 'AUTHORIZED SUBJECT / BEHAVIOR SOURCE',
      content: asText(impersonatingPersona
        ? launch.persona
        : skipAsActor
          ? {
            id: skipAsActor.id,
            name: skipAsActor.name,
            role: skipAsActor.role,
            authoredAsset: skipAsAsset,
            authoredDetails: launch.contextBlocks.find((value) => value.id === skipAsActor.id) ?? null,
          }
          : launch.character ?? { name: 'SIMULATION NARRATOR', description: launch.primaryAsset.summary }),
      priority: 100,
      required: true,
    },
    {
      id: 'viewpoint',
      title: impersonatingPersona ? 'CHARACTER OR NARRATOR / NEVER IMPERSONATE' : 'PLAYER PERSONA / OUTPUT VIEWPOINT / NEVER IMPERSONATE',
      content: asText(impersonatingPersona ? launch.character ?? { name: 'SIMULATION NARRATOR' } : launch.persona),
      priority: 100,
      required: true,
    },
    {
      id: 'scene',
      title: 'AUTHORED SCENE',
      content: asText(launch.scene),
      priority: 100,
      required: true,
    },
    {
      id: 'engine-state',
      title: 'ENGINE STATE / READ ONLY',
      content: asText({
        revision: world.revision,
        elapsedSeconds: world.elapsedSeconds,
        simulationDay: world.simulationDay,
        clock,
        locationId: world.locationId,
        locationLabel: assetsFor(launch).find((asset) => asset.id === world.locationId)?.name ?? null,
        actors: world.actors.map(({ knowledge: _private, ...actor }) => actor),
      }),
      priority: 100,
      required: true,
    },
    {
      id: 'player-perception',
      title: 'PLAYER PERCEPTION / OUTPUT VIEW',
      content: asText(playerPerception),
      priority: 100,
      required: true,
    },
  ];

  if (!impersonatingPersona && subjectPerception) {
    blocks.push({
      id: 'subject-local-context',
      title: 'AUTHORIZED SUBJECT LOCAL CONTEXT / BEHAVIOR ONLY / NOT OUTPUT AUTHORITY',
      content: asText(subjectPerception),
      priority: 92,
    });
  }

  if (!impersonatingPersona && resolution) {
    blocks.push({
      id: 'turn-resolution',
      title: 'TURN RESOLUTION / ENGINE AUTHORITY',
      content: asText({
        schemaVersion: resolution.schemaVersion,
        status: resolution.status,
        worldRevisionBefore: resolution.worldRevisionBefore,
        worldRevisionAfter: resolution.worldRevisionAfter,
        elapsedSeconds: resolution.elapsedSeconds,
        appliedActions: resolution.appliedActions,
        travel: resolution.travel ?? null,
        narrativeCheck: resolution.narrativeCheck ?? null,
        deferredClaims: resolution.deferredClaims,
      }),
      priority: 100,
      required: true,
    });
  }

  if (!impersonatingPersona && launch.character && launch.primaryAsset.type === 'character') {
    const relationship = getRelationship(session.relationships, launch.character.id, launch.persona.id);
    blocks.push({
      id: 'relationship:active-subject',
      title: 'ORBIS / SESSION RELATIONSHIP STATE / BEHAVIOR ONLY / NOT PLAYER KNOWLEDGE',
      content: asText({
        label: relationship.label,
        score: relationship.score,
        dimensions: relationship.dimensions,
        recentEvents: relationship.events.slice(-8).map((event) => ({
          delta: event.delta,
          reason: event.reason,
          dimensionDeltas: event.dimensionDeltas,
        })),
      }),
      priority: 79,
    });
  }

  blocks.push(...relevantDomainBlocks(session));

  const sceneIds = new Set([launch.primaryAsset.id, world.locationId, skipAsActorId, ...playerPerception.presentActors.map((actor) => actor.id)].filter((value): value is string => Boolean(value)));
  for (const asset of assetsFor(launch)) {
    if (!sceneIds.has(asset.id)) continue;
    if (impersonatingPersona && asset.type === 'character') continue;
    if (!impersonatingPersona && asset.type === 'character' && launch.character
      && asset.id !== launch.character.id && asset.id !== skipAsActorId) continue;

    blocks.push({
      id: `asset:${asset.id}`,
      title: `RELEVANT AUTHORED RECORD / ${asset.name}`,
      content: asText(asset),
      priority: 74,
    });
    const detail = launch.contextBlocks.find((value) => value.id === asset.id);
    if (detail) {
      blocks.push({
        id: `asset-detail:${asset.id}`,
        title: `RELEVANT AUTHORED DETAILS / ${asset.name}`,
        content: asText(detail),
        priority: 70,
      });
    }
  }

  const history = historyBlocks(session);
  blocks.push(...history.blocks);

  blocks.push({
    id: 'style',
    title: 'STYLE INFLUENCE / NOT STATE AUTHORITY',
    content: asText({ tags: settings.tags, freeform: settings.freeform }),
    priority: 42,
  });

  blocks.push({
    id: 'input',
    title: impersonatingPersona
      ? 'OPERATOR REQUEST'
      : skippingPersona
        ? 'OPERATOR TURN CONTROL'
        : 'PLAYER INPUT / ATTEMPT OR UTTERANCE / NOT STATE AUTHORITY',
    content: (impersonatingPersona
      ? `Draft only ${launch.persona.name}'s next player turn. Do not write the character or narrator.`
      : skipAsActor
        ? `Player persona turn skipped. Continue one beat as ${skipAsActor.name}. No player action, dialogue, thought or decision occurred in this turn.`
        : skippingPersona
          ? 'Player persona turn skipped. No player action, dialogue, thought or decision occurred in this turn.'
          : player) + '\n\n[IN-WORLD RESPONSE]',
    priority: 100,
    required: true,
  });

  const selection = selectV3ContextBlocks(blocks, CONTEXT_CHARACTER_BUDGET);
  const included = selection.included.map((block) => block.title);
  const omitted = [
    ...selection.omitted.map((block) => `${block.title}: context allowance`),
    ...history.omitted,
  ];

  const outsideScene = assetsFor(launch)
    .filter((asset) => !sceneIds.has(asset.id))
    .map((asset) => `${asset.name}: outside current player-visible scene`);
  omitted.push(...outsideScene);

  return {
    prompt: selection.text,
    included,
    omitted,
    estimatedInputTokens: selection.estimatedTokens,
    outputBudget: settings.maxTokens,
    outputTarget: outputEnvelope.targetTokens,
    completionReserve: outputEnvelope.completionReserveTokens,
    perception: playerPerception,
    playerPerception,
    subjectPerception,
  };
}
