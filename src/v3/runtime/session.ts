import { z } from 'zod';
import type { V3ClientPackage } from '../contracts/launch';
import type { RelationshipState } from '../../runtime/relationships/schema';
import { removeRelationshipTurns } from '../../runtime/relationships/core';
import { applyWorldAction, createWorld, worldSchema, type WorldAction } from './world';
import { stateProposalsSchema, type V3StateProposal } from './state-proposals';

export const OUTPUT_PRESETS = { short: 256, normal: 512, long: 1024, marathon: 2048 } as const;
export const DEFAULT_TEXT_COLORS = { actionColor: '#d6d1c3', dialogueColor: '#f3e7ad', thoughtColor: '#a9c7d8' } as const;
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
export const settingsSchema = z.object({
  output: z.enum(['short', 'normal', 'long', 'marathon']).default('normal'),
  maxTokens: z.number().int().min(32).max(4096).default(512),
  temperature: z.number().min(0).max(2).default(0.85),
  topK: z.number().int().min(0).max(1000).default(250), topP: z.number().min(0).max(1).default(0.95),
  presencePenalty: z.number().min(-2).max(2).default(0), frequencyPenalty: z.number().min(-2).max(2).default(0),
  stopSequences: z.array(z.string().min(1).max(200)).max(16).default([]),
  continueToEndOfSentence: z.boolean().default(true),
  crtEffects: z.boolean().default(true), tags: z.string().max(1000).default(''), freeform: z.string().max(4000).default(''),
  actionColor: colorSchema.default(DEFAULT_TEXT_COLORS.actionColor),
  dialogueColor: colorSchema.default(DEFAULT_TEXT_COLORS.dialogueColor),
  thoughtColor: colorSchema.default(DEFAULT_TEXT_COLORS.thoughtColor),
});
const generationSettingsSchema = settingsSchema.pick({
  output: true, maxTokens: true, temperature: true, topK: true, topP: true,
  presencePenalty: true, frequencyPenalty: true, stopSequences: true, continueToEndOfSentence: true,
});
export type V3Settings = z.infer<typeof settingsSchema>;
export type V2Settings = V3Settings;
export const diagnosticsSchema = z.object({
  prompt: z.string().max(500_000), estimatedInputTokens: z.number(), outputBudget: z.number(),
  included: z.array(z.string()), omitted: z.array(z.string()),
  issues: z.array(z.string()), warnings: z.array(z.string()), model: z.string(), durationMs: z.number(),
  completionStatus: z.string(), worldRevision: z.number().int(),
  viewpointActorId: z.string().optional(), subjectActorId: z.string().nullable().optional(),
  resolutionStatus: z.enum(['authoritative-noop', 'resolved', 'deferred']).optional(),
  resolutionDeferredClaims: z.array(z.string()).optional(),
  resolutionElapsedSeconds: z.number().int().nonnegative().optional(),
  resolutionCheck: z.object({
    kind: z.literal('genesys-style'), successes: z.number().int(), advantages: z.number().int(),
    triumph: z.boolean(), despair: z.boolean(), summary: z.string().max(500),
  }).optional(),
  providerKind: z.string().optional(), providerEndpoint: z.string().optional(), requestId: z.string().optional(),
  finishReason: z.string().optional(), requestedMaxTokens: z.number().optional(), providerInputTokensEstimate: z.number().optional(),
  generationSettings: generationSettingsSchema.optional(),
});
export type V3Diagnostics = z.infer<typeof diagnosticsSchema>;
export type V2Diagnostics = V3Diagnostics;
const relationshipDimensionsSchema = z.object({
  trust: z.number().finite().default(0),
  affection: z.number().finite().default(0),
  respect: z.number().finite().default(0),
  fear: z.number().finite().default(0),
  comfort: z.number().finite().default(0),
  suspicion: z.number().finite().default(0),
  attachment: z.number().finite().default(0),
  protectiveness: z.number().finite().default(0),
  resentment: z.number().finite().default(0),
  loyalty: z.number().finite().default(0),
  familiarity: z.number().finite().default(0),
  authority: z.number().finite().default(0),
});

const relationshipEventStateSchema = z.object({
  id: z.string().min(1),
  characterId: z.string().min(1),
  personaId: z.string().min(1),
  turnId: z.string().min(1),
  delta: z.number().finite(),
  reason: z.string().max(2000),
  dimensionDeltas: z.record(z.string(), z.number().finite()).default({}),
  createdAt: z.number().finite(),
});

const relationshipRecordStateSchema = z.object({
  characterId: z.string().min(1),
  personaId: z.string().min(1),
  baselineScore: z.number().finite().default(0),
  score: z.number().finite().default(0),
  label: z.string().max(120).default('STRANGER'),
  dimensions: relationshipDimensionsSchema.default(() => relationshipDimensionsSchema.parse({})),
  events: z.array(relationshipEventStateSchema).max(20_000).default([]),
  updatedAt: z.number().finite().default(0),
});

export const relationshipStateSchema = z.record(z.string(), relationshipRecordStateSchema).default({});

export function normalizeRelationshipState(value: unknown): RelationshipState {
  const parsed = relationshipStateSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export const sessionStateProposalsSchema = stateProposalsSchema;

export const turnSchema = z.object({
  id: z.string().min(1), player: z.string().min(1).max(16000), reply: z.string().min(1).max(64000),
  createdAt: z.number(), worldRevision: z.number().int(), diagnostics: diagnosticsSchema,
});
export type V3Turn = z.infer<typeof turnSchema>;
export type V2Turn = V3Turn;
export const eventSchema = z.object({
  id: z.string().min(1), kind: z.enum(['operator', 'turn']), label: z.string().max(200),
  worldRevision: z.number().int(), at: z.number(), world: worldSchema.optional(),
  ownerTurnId: z.string().min(1).max(300).nullable().default(null),
});
export type V3Session = {
  version: 3; engine: 'v3'; id: string; launch: V3ClientPackage;
  world: z.infer<typeof worldSchema>; settings: V3Settings; draft: string;
  turns: V3Turn[]; events: z.infer<typeof eventSchema>[]; nextTurn: number;
  relationships: RelationshipState;
  stateProposals: V3StateProposal[];
};

export type V2Session = V3Session;

export function createV3Session(launch: V3ClientPackage): V3Session {
  return {
    version: 3, engine: 'v3', id: crypto.randomUUID(), launch,
    world: createWorld(launch), settings: settingsSchema.parse({}), draft: '', turns: [], events: [], nextTurn: 1,
    relationships: normalizeRelationshipState(launch.relationshipState),
    stateProposals: [],
  };
}

// Transitional alias for inherited V3 code. New code should use createV3Session.
export const createV2Session = createV3Session;

export function operateWorld(session: V2Session, action: WorldAction, now = Date.now(), ownerTurnId: string | null = null): V2Session {
  const world = applyWorldAction(session.world, action, session.launch);
  return {
    ...session, world,
    events: [...session.events, { id: `operator:${world.revision}`, kind: 'operator', label: action.type, worldRevision: world.revision, at: now, world, ownerTurnId }],
  };
}

export function rollbackTurnOwnedActions(session: V2Session, turnId: string): V2Session {
  const turnIndex = session.events.findIndex((event) => event.kind === 'turn' && event.id === turnId);
  if (turnIndex < 0) return session;
  const trailing = session.events.slice(turnIndex + 1);
  const unrelated = trailing.find((event) => event.kind === 'operator' && event.ownerTurnId !== turnId);
  if (unrelated) {
    throw new Error('Reroll/delete cannot cross later operator state changes. Undo those operator changes first.');
  }

  const removed = trailing.filter((event) => event.kind === 'operator' && event.ownerTurnId === turnId);
  if (!removed.length) return session;
  const remainingEvents = session.events.filter((event) => !(event.kind === 'operator' && event.ownerTurnId === turnId));
  const targetRevision = session.turns.find((turn) => turn.id === turnId)?.worldRevision ?? session.world.revision;
  const previousWorld = [...remainingEvents].reverse()
    .find((event) => event.kind === 'operator' && event.world && event.worldRevision <= targetRevision)?.world
    ?? createWorld(session.launch);
  return { ...session, world: previousWorld, events: remainingEvents };
}

export function deleteLastTurn(session: V2Session): V2Session {
  const last = session.turns.at(-1);
  if (!last) return session;
  const rolledBack = rollbackTurnOwnedActions(session, last.id);
  if (last.worldRevision !== rolledBack.world.revision) {
    throw new Error('Delete latest requires unchanged world state after that turn. Undo later operator changes first.');
  }
  const resolutionId = `${last.id}:resolution`;
  const remainingEvents = rolledBack.events.filter((event) => event.id !== last.id && event.id !== resolutionId);
  const previousWorld = [...remainingEvents].reverse().find((event) => event.kind === 'operator' && event.world)?.world ?? createWorld(session.launch);
  const relationships = session.launch.character && session.launch.primaryAsset.type === 'character'
    ? removeRelationshipTurns(session.relationships, session.launch.character.id, session.launch.persona.id, [last.id])
    : session.relationships;
  return {
    ...session,
    world: previousWorld,
    turns: session.turns.slice(0, -1),
    events: remainingEvents,
    relationships,
    stateProposals: rolledBack.stateProposals.filter((proposal) => proposal.sourceTurnId !== last.id),
  };
}
