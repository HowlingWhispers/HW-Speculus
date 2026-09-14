import type { V2Session } from './session';
import type { V2TurnResolution } from './resolution';
import { SKIPPED_PERSONA_TURN } from './turn-control';
import { assetsFor, perceptionFor } from './world';

// A conservative, explicitly estimated prompt allowance, independent of output
// presets. Exact model tokenization and semantic long-term recall are later work.
export const CONTEXT_CHARACTER_BUDGET = 28_000;
export type V2RenderMode = 'normal' | 'skip-persona' | 'impersonate-persona';
const section = (title: string, value: unknown) => `\n[${title}]\n${typeof value === 'string' ? value : JSON.stringify(value)}\n`;

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
  const outputEnvelope = v2OutputEnvelope(settings.maxTokens);
  const impersonatingPersona = mode === 'impersonate-persona';
  const skippingPersona = mode === 'skip-persona';
  const playerPerception = resolution?.playerPerception ?? perceptionFor(world, launch.persona.id);
  const subjectActorId = launch.character?.id ?? null;
  const subjectPerception = impersonatingPersona
    ? playerPerception
    : resolution?.subjectPerception ?? (subjectActorId ? perceptionFor(world, subjectActorId) : null);
  const outputRules = [
    `The provider hard ceiling is ${outputEnvelope.hardLimitTokens} tokens. This is an emergency ceiling, never a target.`,
    `Aim to finish the complete turn by about ${outputEnvelope.targetTokens} tokens and leave roughly ${outputEnvelope.completionReserveTokens} tokens unused as a completion reserve.`,
    'Near the target, finish the current immediate beat and stop. Do not begin a new sentence, paragraph, action, or dialogue exchange merely because budget remains.',
    'Never trade a complete ending for extra description. Every opened quote, asterisk-delimited action, or bracketed inner voice must be closed before stopping.',
    'Ending naturally well below the hard ceiling is correct. Do not pad the response to consume the allowance.',
  ];
  const instructions = impersonatingPersona ? [
    'SPECULUS V2 / PLAYER PERSONA IMPERSONATION CONTRACT',
    `Write only the next in-world turn for the player persona ${launch.persona.name}. This is an explicit operator-requested impersonation of the player persona only.`,
    'Do not write, continue, react for, or impersonate the character or simulation narrator. Their next turn belongs to the normal renderer after the player draft is sent.',
    'The engine owns physical locations, elapsed time and actor presence. Unknown means unknown, not permission to fill in authoritative state.',
    'Do not invent named places, teleport actors, advance the clock, close the scene, or alter engine state.',
    'Use only information available to the player persona from authored persona data, current scene state, current perception and the visible recent exchange.',
    'Write only in-world roleplay: dialogue in double quotes, action/narration in single asterisks, inner voice in square brackets.',
    'Use real roleplay punctuation and real line breaks. Do not serialize the response as JSON or escape its punctuation.',
    `Begin directly with ${launch.persona.name}'s action, dialogue, or inner voice. Do not prefix a speaker name, role label, heading, explanation, or menu.`,
    'Stop when the player persona turn is complete. Do not generate the other side of the exchange.',
    ...outputRules,
  ].join('\n') : [
    'SPECULUS V2 / PLAYER-PERSPECTIVE WORLD RENDERING CONTRACT',
    'Render the current simulated world through the player persona\'s perceptual viewpoint. The authorized subject may act, but the prose camera belongs to the player.',
    'The renderer is downstream from world resolution. It may describe state and observable consequences, but it is not allowed to make generated prose authoritative state.',
    'The engine owns physical locations, elapsed time and actor presence. Unknown means unknown, not permission to fill in authoritative state.',
    'Do not invent named places, teleport actors, advance the clock, close the scene, or write actions, thoughts, dialogue, consent, decisions or movement for the player.',
    'Only explicitly present actors can interact. Related canon is not automatically known, perceived or physically present.',
    'Authorized-subject private context may guide behavior, but must never be exposed as narration unless the player can perceive its outward evidence or already knows it.',
    'Do not narrate NPC private thoughts, hidden motives, offscreen events or unseen facts as player-visible truth.',
    'Authored world and character rules govern behavior. Apply consistency and causality without adding a universal moral personality.',
    'Write only in-world roleplay: dialogue in double quotes and action/environment narration in single asterisks. Do not invent square-bracket inner voice for NPCs or the player.',
    'Use real roleplay punctuation and real line breaks. Do not serialize the response as JSON or escape its punctuation.',
    'Begin directly with an immediate player-observable action, reaction, dialogue or environmental consequence. Do not prefix it with a speaker name, role label, or response heading.',
    'Do not output engine status, rules, state patches, analysis, headings, menus or a request for the player to choose their next move.',
    skippingPersona
      ? 'The operator explicitly skipped the player persona turn. Continue from current resolved state and do not invent any player action, dialogue, thought, consent, decision or movement.'
      : 'Player input describes an attempt or utterance. It is evidence for resolution, not permission for the renderer to rewrite canon or engine state.',
    ...outputRules,
    launch.character ? `Authorized subject for behavior: ${launch.character.name}. Render only the outward result available to ${launch.persona.name}.` : `You are the simulation narrator. Render only what ${launch.persona.name} can perceive or already knows.`,
  ].join('\n');

  const included = [
    impersonatingPersona ? 'Persona impersonation contract' : 'Player-perspective rendering contract',
    'Output completion envelope', 'Source identity', 'Subject', 'Scene', 'World state', 'Player perception',
  ];
  const omitted: string[] = [];
  let prompt = instructions
    + section('OUTPUT BUDGET / HARD CEILING', outputEnvelope)
    + section('SOURCE IDENTITY', { id: launch.primaryAsset.id, revision: launch.primaryAsset.revision, type: launch.primaryAsset.type, name: launch.primaryAsset.name })
    + (impersonatingPersona
      ? section('PLAYER PERSONA / AUTHORIZED SUBJECT', launch.persona)
      : section('AUTHORIZED SUBJECT / BEHAVIOR SOURCE', launch.character ?? { name: 'SIMULATION NARRATOR', description: launch.primaryAsset.summary }))
    + (impersonatingPersona
      ? section('CHARACTER OR NARRATOR / NEVER IMPERSONATE', launch.character ?? { name: 'SIMULATION NARRATOR' })
      : section('PLAYER PERSONA / OUTPUT VIEWPOINT / NEVER IMPERSONATE', launch.persona))
    + section('AUTHORED SCENE', launch.scene)
    + section('ENGINE STATE / READ ONLY', { revision: world.revision, elapsedSeconds: world.elapsedSeconds, locationId: world.locationId, locationLabel: assetsFor(launch).find((asset) => asset.id === world.locationId)?.name ?? null, actors: world.actors.map(({ knowledge: _private, ...actor }) => actor) })
    + section('PLAYER PERCEPTION / OUTPUT VIEW', playerPerception);

  if (!impersonatingPersona && subjectPerception) {
    prompt += section('AUTHORIZED SUBJECT LOCAL CONTEXT / BEHAVIOR ONLY / NOT OUTPUT AUTHORITY', subjectPerception);
    included.push('Authorized subject local context');
  }
  if (!impersonatingPersona && resolution) {
    prompt += section('TURN RESOLUTION / ENGINE AUTHORITY', {
      schemaVersion: resolution.schemaVersion,
      status: resolution.status,
      worldRevisionBefore: resolution.worldRevisionBefore,
      worldRevisionAfter: resolution.worldRevisionAfter,
      appliedActions: resolution.appliedActions,
      deferredClaims: resolution.deferredClaims,
    });
    included.push('Turn resolution');
  }

  const influence = section('STYLE INFLUENCE / NOT STATE AUTHORITY', { tags: settings.tags, freeform: settings.freeform });
  const input = impersonatingPersona
    ? section('OPERATOR REQUEST', `Draft only ${launch.persona.name}'s next player turn. Do not write the character or narrator.`) + '\n[PLAYER PERSONA DRAFT]\n'
    : skippingPersona
      ? section('OPERATOR TURN CONTROL', 'Player persona turn skipped. No player action, dialogue, thought or decision occurred in this turn.') + '\n[IN-WORLD RESPONSE]\n'
      : section('PLAYER INPUT / ATTEMPT OR UTTERANCE / NOT STATE AUTHORITY', player) + '\n[IN-WORLD RESPONSE]\n';
  if ((prompt + influence + input).length > CONTEXT_CHARACTER_BUDGET) {
    throw new Error('Essential scene/state and input exceed the V2 context allowance. Nothing was cut or sent. Shorten the setup/input before retrying.');
  }

  // Recent dialogue is intentionally kept as plain roleplay text. Serializing it
  // as JSON teaches the model to imitate escaped quotes/newlines in later turns.
  const recent = session.turns.slice(-4).map((turn) => '\n[RECENT EXCHANGE / NOT ENGINE AUTHORITY]\n'
    + (turn.player === SKIPPED_PERSONA_TURN
      ? '[PLAYER TURN]\n(skipped by operator)\n'
      : `[PLAYER TURN]\n${turn.player}\n`)
    + `[WORLD RENDER / PLAYER-VISIBLE PROSE]\n${turn.reply}\n`
    + '[END RECENT EXCHANGE]\n');
  let history = '';
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if ((prompt + influence + recent[i] + history + input).length > CONTEXT_CHARACTER_BUDGET) {
      omitted.push(`${recent.length - i} older recent exchange(s): context allowance`);
      break;
    }
    history = recent[i] + history;
  }
  if (session.turns.length > 4) omitted.push(`${session.turns.length - 4} older exchange(s): no semantic recall in this foundation`);
  if (history) included.push('Recent complete exchanges');

  const sceneIds = new Set([launch.primaryAsset.id, world.locationId, ...playerPerception.presentActors.map((actor) => actor.id)]);
  for (const asset of assetsFor(launch)) {
    if (!sceneIds.has(asset.id)) { omitted.push(`${asset.name}: outside current player-visible scene`); continue; }
    if (impersonatingPersona && asset.type === 'character') {
      omitted.push(`${asset.name}: character private data excluded from player impersonation`);
      continue;
    }
    if (!impersonatingPersona && asset.type === 'character' && launch.character && asset.id !== launch.character.id) {
      omitted.push(`${asset.name}: unrelated character private data excluded`);
      continue;
    }
    const data = section('RELEVANT AUTHORED RECORD / DATA', asset);
    if ((prompt + data + influence + history + input).length <= CONTEXT_CHARACTER_BUDGET) {
      prompt += data; included.push(asset.name);
    } else omitted.push(`${asset.name}: full record exceeds remaining allowance`);
    const block = launch.contextBlocks.find((value) => value.id === asset.id);
    if (block) {
      const details = section('RELEVANT AUTHORED DETAILS / DATA', block);
      if ((prompt + details + influence + history + input).length <= CONTEXT_CHARACTER_BUDGET) {
        prompt += details; included.push(`${asset.name}: authored details`);
      } else omitted.push(`${asset.name}: authored details exceed remaining allowance`);
    }
  }
  prompt += influence + history + input;
  return {
    prompt, included, omitted, estimatedInputTokens: Math.ceil(prompt.length / 4), outputBudget: settings.maxTokens,
    outputTarget: outputEnvelope.targetTokens, completionReserve: outputEnvelope.completionReserveTokens,
    perception: playerPerception, playerPerception, subjectPerception,
  };
}
