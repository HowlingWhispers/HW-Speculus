import { getRelationship } from '../../runtime/relationships/core';
import { OUTPUT_PRESETS, type V4Session, type V4Turn } from './session';
import type { V4TurnResolution } from './resolution';
import { selectV4ContextBlocks, type V4ContextBlock } from './context-blocks';
import { V4_ANTI_SLOP_GUIDANCE } from './prose-quality';
import { isSkippedPersonaTurn, skippedPersonaActorId } from './turn-control';
import { assetsFor, perceptionFor, worldClock } from './world';

export const CONTEXT_CHARACTER_BUDGET = 28_000;
export const V4_RECENT_EXCHANGE_COUNT = 4;
export const V4_CHRONICLE_TURN_COUNT = 12;
export const V4_ARCHIVE_TURN_COUNT = 48;
// The narrative frontier gets a reserved, deterministically clipped block so an
// oversized newest reply can never be dropped wholesale by atomic selection.
export const V4_CONTINUITY_TURN_COUNT = 2;
export const V4_CONTINUITY_CHARACTER_BUDGET = 6_000;
const V4_CONTINUITY_PLAYER_HEAD = 400;
const V4_CONTINUITY_PLAYER_TAIL = 200;
const V4_CONTINUITY_REPLY_HEAD = 1_400;
const V4_CONTINUITY_REPLY_TAIL = 2_000;

export type V4RenderMode = 'normal' | 'skip-persona' | 'impersonate-persona';

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

function skippedTurnText(turn: V4Turn, session: V4Session, compact = false) {
  const actorId = skippedPersonaActorId(turn.player);
  if (!actorId) return compact ? '(skipped)' : '(turn skipped by operator)';
  const actorName = session.world.actors.find((actor) => actor.id === actorId)?.name ?? actorId;
  return compact ? `(skipped as ${actorName})` : `(turn skipped by operator; continue as ${actorName})`;
}

function replySubjectName(turn: V4Turn, session: V4Session, fallback: string) {
  const actorId = skippedPersonaActorId(turn.player);
  return actorId ? session.world.actors.find((actor) => actor.id === actorId)?.name ?? actorId : fallback;
}

function recentExchange(turn: V4Turn, session: V4Session, playerName: string, subjectName: string) {
  const replySubject = replySubjectName(turn, session, subjectName);
  return isSkippedPersonaTurn(turn.player)
    ? `Player ${playerName}: ${skippedTurnText(turn, session)}\n${replySubject}:\n${turn.reply}`
    : `Player ${playerName}:\n${turn.player}\n${replySubject}:\n${turn.reply}`;
}

function chronicleExchange(turn: V4Turn, session: V4Session, playerName: string, subjectName: string) {
  const player = isSkippedPersonaTurn(turn.player)
    ? skippedTurnText(turn, session)
    : clipChronicleText(turn.player, 240);
  const reply = clipChronicleText(turn.reply, 620);
  const replySubject = replySubjectName(turn, session, subjectName);
  return [
    `Turn ${turn.id} / world r${turn.worldRevision}`,
    `${playerName}: ${player}`,
    `${replySubject}: ${reply}`,
  ].join('\n');
}

function archiveLine(turn: V4Turn, session: V4Session, playerName: string, subjectName: string) {
  const player = isSkippedPersonaTurn(turn.player) ? skippedTurnText(turn, session, true) : clipChronicleText(turn.player, 90);
  const reply = clipChronicleText(turn.reply, 180);
  const replySubject = replySubjectName(turn, session, subjectName);
  return `${turn.id} | ${playerName}: ${player} | ${replySubject}: ${reply}`;
}

const ELISION_MARKER = '[... earlier prose elided to protect the continuity budget; wording above and below is verbatim ...]';

/**
 * Clips while keeping the head (who acted) and the tail (where the next turn
 * must continue). Never rewords, only drops the middle.
 */
function clipKeepingContinuity(value: string, head: number, tail: number) {
  const trimmed = value.trim();
  if (trimmed.length <= head + tail) return trimmed;
  return `${trimmed.slice(0, head).trimEnd()}\n${ELISION_MARKER}\n${trimmed.slice(-tail).trimStart()}`;
}

function continuityExchange(turn: V4Turn, session: V4Session, playerName: string, subjectName: string, isLatest: boolean) {
  const replySubject = replySubjectName(turn, session, subjectName);
  const player = isSkippedPersonaTurn(turn.player)
    ? skippedTurnText(turn, session)
    : clipKeepingContinuity(turn.player, V4_CONTINUITY_PLAYER_HEAD, V4_CONTINUITY_PLAYER_TAIL);
  const reply = clipKeepingContinuity(turn.reply, V4_CONTINUITY_REPLY_HEAD, V4_CONTINUITY_REPLY_TAIL);
  return [
    `Turn ${turn.id} | committed at world revision r${turn.worldRevision} | ${isLatest ? 'LATEST COMMITTED TURN / NARRATIVE FRONTIER' : 'previous committed turn'}`,
    `Player ${playerName} said:`,
    player,
    `${replySubject} replied (${isLatest ? 'final visible state of the scene; continue directly from its last line' : 'earlier committed reply'}):`,
    reply,
  ].join('\n');
}

export type V4ContinuityDiagnostics = {
  latestCommittedTurnId: string | null;
  continuityFrontierTurnId: string | null;
  continuityTurnIds: string[];
  recentTurnIdsOffered: string[];
  recentTurnIdsIncluded: string[];
  recentTurnIdsClipped: string[];
  recentTurnIdsOmitted: Array<{ id: string; reason: string }>;
  latestTurnMissingFromContext: boolean;
};

function historyBlocks(session: V4Session): { blocks: V4ContextBlock[]; omitted: string[]; continuity: V4ContinuityDiagnostics } {
  const subjectName = session.launch.character?.name ?? 'Simulation Narrator';
  const playerName = session.launch.persona.name;
  // The continuity block exclusively owns the newest committed turns. Ordinary
  // recent/chronicle/archive selection starts strictly before it, so the same
  // exchange is never rendered twice.
  const continuityCount = Math.min(V4_CONTINUITY_TURN_COUNT, session.turns.length);
  const continuityTurns = session.turns.slice(session.turns.length - continuityCount);
  const recentStart = Math.max(0, session.turns.length - continuityCount - V4_RECENT_EXCHANGE_COUNT);
  const recentTurns = session.turns.slice(recentStart, session.turns.length - continuityCount);
  const older = session.turns.slice(0, recentStart);
  const chronicleStart = Math.max(0, older.length - V4_CHRONICLE_TURN_COUNT);
  const chronicleTurns = older.slice(chronicleStart);
  const archiveCandidates = older.slice(0, chronicleStart);
  const archiveTurns = archiveCandidates.slice(-V4_ARCHIVE_TURN_COUNT);
  const omitted: string[] = [];

  if (archiveCandidates.length > archiveTurns.length) {
    omitted.push(`${archiveCandidates.length - archiveTurns.length} oldest exchange(s): beyond deterministic V4 archive window`);
  }

  const blocks: V4ContextBlock[] = [];

  const latestCommittedTurnId = session.turns.at(-1)?.id ?? null;
  const continuityTurnIds = continuityTurns.map((turn) => turn.id);
  const continuityFrontierTurnId = latestCommittedTurnId;
  const recentTurnIdsOffered = recentTurns.map((turn) => turn.id);
  // Only the continuity window can be clipped; recent/chronicle/archive already
  // clip their own text and are never reported as frontier clips.
  const recentTurnIdsClipped = continuityTurns
    .filter((turn) => turn.reply.length > V4_CONTINUITY_REPLY_HEAD + V4_CONTINUITY_REPLY_TAIL)
    .map((turn) => turn.id);

  // Both windows are required and emitted in index order, so the renderer reads
  // recent history oldest-first and then the frontier, keeping one ascending
  // chronological narrative instead of duplicating the newest exchanges.
  if (recentTurns.length) {
    blocks.push({
      id: 'recent-history',
      title: 'RECENT COMMITTED EXCHANGES BEFORE THE CURRENT FRONTIER / OLDEST FIRST',
      content: recentTurns
        .map((turn) => chronicleExchange(turn, session, playerName, subjectName))
        .join('\n\n'),
      priority: 99,
      required: true,
    });
  }

  if (continuityTurns.length) {
    blocks.push({
      id: 'immediate-continuity',
      title: 'IMMEDIATE CONTINUITY / LATEST COMMITTED EXCHANGE / ALWAYS AUTHORITATIVE FOR SCENE FRONTIER',
      content: [
        'Continue directly from the end of the latest committed exchange below. This exchange is the current narrative frontier. Older chronicle or archive material is background only and must never replace or supersede it.',
        ...continuityTurns.map((turn, index) => continuityExchange(turn, session, playerName, subjectName, index === continuityTurns.length - 1)),
      ].join('\n'),
      priority: 99,
      required: true,
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

  return {
    blocks,
    omitted,
    continuity: {
      latestCommittedTurnId,
      continuityFrontierTurnId,
      continuityTurnIds,
      recentTurnIdsOffered,
      recentTurnIdsClipped,
      recentTurnIdsIncluded: [],
      recentTurnIdsOmitted: [],
      latestTurnMissingFromContext: false,
    },
  };
}

function relevantDomainBlocks(session: V4Session): V4ContextBlock[] {
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

  const blocks: V4ContextBlock[] = [];
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

// Short is a prose-length contract, not a tiny provider hard stop. Existing
// autosaves retain maxTokens=256, so give those defaults completion headroom
// without changing the saved preference or overriding custom advanced limits.
export function v4ProviderOutputBudget(settings: Pick<V4Session['settings'], 'output' | 'maxTokens'>): number {
  return settings.output === 'short' && settings.maxTokens === OUTPUT_PRESETS.short
    ? 768
    : settings.maxTokens;
}

export function v4OutputEnvelope(maxTokens: number) {
  const completionReserveTokens = Math.min(512, Math.max(8, Math.floor(maxTokens * 0.25)));
  return {
    hardLimitTokens: maxTokens,
    targetTokens: Math.max(16, maxTokens - completionReserveTokens),
    completionReserveTokens,
  };
}

export type V4OutputPreset = 'short' | 'normal' | 'long' | 'marathon';

export type V4OutputContract = {
  preset: V4OutputPreset;
  ceilingTokens: number;
  targetMinTokens: number;
  targetMaxTokens: number;
  paragraphs: string;
  emphasis: string[];
};

/**
 * The numeric ceiling is not a writing instruction. Each preset carries its own
 * explicit shape contract so the model is told how to behave, not just how much
 * room it has. Marathons expand depth inside the current beat, never time.
 */
export function outputContractFor(preset: V4OutputPreset, envelope: { hardLimitTokens: number; targetTokens: number }): V4OutputContract {
  const base = { preset, ceilingTokens: envelope.hardLimitTokens, paragraphs: '', emphasis: [] as string[] };
  const boundedRange = (targetMinTokens: number, targetMaxTokens: number) => {
    const boundedMax = Math.max(16, Math.min(targetMaxTokens, envelope.targetTokens));
    return {
      targetMaxTokens: boundedMax,
      targetMinTokens: Math.max(16, Math.min(targetMinTokens, boundedMax)),
    };
  };
  if (preset === 'short') {
    return {
      ...base,
      ...boundedRange(80, 160),
      paragraphs: 'usually 1-2 short paragraphs',
      emphasis: [
        'Write one immediate action, reaction, or dialogue beat and stop.',
        'No recap, no scene expansion, no extra conversational exchange.',
        'Stop promptly after the immediate response rather than filling the ceiling.',
      ],
    };
  }
  if (preset === 'long') {
    return {
      ...base,
      ...boundedRange(450, 800),
      paragraphs: 'usually 4-7 readable paragraphs',
      emphasis: [
        'Develop deeper description, reactions and atmosphere around the current beat.',
        'Still do not advance multiple turns or finish an entire scene.',
      ],
    };
  }
  if (preset === 'marathon') {
    return {
      ...base,
      ...boundedRange(900, 1600),
      paragraphs: 'several readable paragraphs',
      emphasis: [
        'MARATHON means write substantially more about the current playable beat. Expand DEPTH, not TIME.',
        'Add richer sensory and environmental detail, physical reactions, dialogue texture and scene detail.',
        'Do not manufacture multiple NPC exchanges, skip player decisions, close the topic, or fast-forward the scene merely to become longer.',
        'Never simulate the next ten minutes of play without the player.',
      ],
    };
  }
  return {
    ...base,
    preset: 'normal',
    ...boundedRange(220, 400),
    paragraphs: 'usually 2-4 readable paragraphs',
    emphasis: [
      'Deliver one immediate playable beat with moderate description.',
    ],
  };
}

const readabilityRules = [
  'Use short paragraphs. No giant prose blocks. Prefer a blank line between natural roleplay paragraphs.',
  'No headings, bullet lists, speaker labels, or out-of-character formatting.',
];

export function compileV4Context(
  session: V4Session,
  player = '',
  mode: V4RenderMode = 'normal',
  resolution?: V4TurnResolution,
) {
  const { launch, world, settings } = session;
  const clock = worldClock(world);
  const outputEnvelope = v4OutputEnvelope(v4ProviderOutputBudget(settings));
  const outputContract = outputContractFor(settings.output, outputEnvelope);
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
    `PRESET: ${outputContract.preset.toUpperCase()}. Target ~${outputContract.targetMaxTokens} tokens, hard ceiling ${outputEnvelope.hardLimitTokens} tokens.`,
    'Finish the current beat naturally. Close all quotes/actions/brackets before stopping. Do not pad or start a new exchange.',
    ...V4_ANTI_SLOP_GUIDANCE,
  ];

  const instructions = impersonatingPersona ? [
    'IMPERSONATION CONTRACT: write only the next in-world turn for the player persona. Do not write for the character or narrator.',
    'Use authored persona data, current scene state, current perception, and visible recent exchange only. Chronicle/archive is context, not override.',
    'Roleplay only: dialogue in double quotes, action/narration in single asterisks, inner voice in square brackets. No JSON, no OOC, no menus.',
    `Begin directly with ${launch.persona.name}'s action, dialogue, or inner voice. Do not prefix a speaker name or heading.`,
    'Stop when this single player beat is complete. Do not generate the other side.',
    ...outputRules,
    ...readabilityRules,
  ].join('\n') : [
    'RENDERING CONTRACT: render the current world through the player persona\'s perceptual viewpoint. The renderer is downstream from engine state.',
    'Use authored world/character rules and current engine state. Do not invent places, advance time, close scenes, or write player actions/consent/decisions.',
    'Roleplay only: dialogue in double quotes, action/environment narration in single asterisks. No JSON, no OOC, no NPC inner voice.',
    'Begin directly with an immediate player-observable action, reaction, dialogue, or environmental consequence. No speaker labels or headings.',
    'One generation advances one immediate playable beat. Do not compress a whole conversation, argument, meal, journey, or emotional arc into one response.',
    skipAsActor
      ? `Skip turn: write only ${skipAsActor.name}'s next immediate beat. No full exchange, no player invention.`
      : skippingPersona
        ? 'Skip turn: continue one immediate beat from resolved state. No player invention.'
        : 'Player input is evidence for resolution, not permission to rewrite canon or engine state.',
    ...(skippingPersona ? [
      'Skip continuity: continue from the end of the latest committed exchange. Older material is background only.',
      'One skip advances exactly one beat. No time advancement unless engine mechanics performed it.',
    ] : []),
    ...outputRules,
    ...readabilityRules,
    skipAsActor
      ? `Authorized subject: ${skipAsActor.name}. Render only their outward result.`
      : launch.character
        ? `Authorized subject: ${launch.character.name}. Render only their outward result.`
        : `You are the simulation narrator. Render only what ${launch.persona.name} can perceive or knows.`,
  ].join('\n');

  const blocks: V4ContextBlock[] = [
    {
      id: 'contract',
      title: 'SPECULUS V4 EXPERIMENTAL / RENDERING CONTRACT',
      content: instructions,
      priority: 100,
      required: true,
    },
    {
      id: 'output-envelope',
      title: 'OUTPUT PRESET CONTRACT / TARGET SHAPE AND HARD CEILING',
      content: asText({
        preset: outputContract.preset,
        ceilingTokens: outputContract.ceilingTokens,
        targetMinTokens: outputContract.targetMinTokens,
        targetMaxTokens: outputContract.targetMaxTokens,
        paragraphs: outputContract.paragraphs,
        emphasis: outputContract.emphasis,
        completionReserveTokens: outputEnvelope.completionReserveTokens,
      }),
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

  const selection = selectV4ContextBlocks(blocks, CONTEXT_CHARACTER_BUDGET);
  const included = selection.included.map((block) => block.title);
  const omitted = [
    ...selection.omitted.map((block) => `${block.title}: context allowance`),
    ...history.omitted,
  ];

  // Continuity diagnostics are computed from the real selection outcome, never
  // from intent, so a dropped frontier turn is always visible.
  const includedIds = new Set(selection.included.map((block) => block.id));
  const continuity = history.continuity;
  // The recent window is one required block, so it is included or the compile
  // already threw. Report it honestly either way.
  const recentGroupIncluded = includedIds.has('recent-history');
  const recentTurnIdsIncluded = recentGroupIncluded ? [...continuity.recentTurnIdsOffered] : [];
  const recentTurnIdsOmitted = recentGroupIncluded
    ? []
    : continuity.recentTurnIdsOffered.map((id) => ({ id, reason: 'required context did not fit the budget' }));
  const frontierId = continuity.continuityFrontierTurnId;
  const latestTurnMissingFromContext = frontierId !== null && !selection.text.includes(frontierId);
  if (latestTurnMissingFromContext) {
    omitted.push(`CRITICAL: latest committed turn ${frontierId} is absent from renderer context during Skip.`);
  }

  const outsideScene = assetsFor(launch)
    .filter((asset) => !sceneIds.has(asset.id))
    .map((asset) => `${asset.name}: outside current player-visible scene`);
  omitted.push(...outsideScene);

  return {
    prompt: selection.text,
    included,
    omitted,
    estimatedInputTokens: selection.estimatedTokens,
    outputBudget: outputEnvelope.hardLimitTokens,
    outputTarget: outputEnvelope.targetTokens,
    completionReserve: outputEnvelope.completionReserveTokens,
    outputPreset: settings.output,
    outputContract: outputContractFor(settings.output, outputEnvelope),
    continuity: {
      ...continuity,
      recentTurnIdsIncluded,
      recentTurnIdsOmitted,
      latestTurnMissingFromContext,
    },
    perception: playerPerception,
    playerPerception,
    subjectPerception,
  };
}
