import { z } from 'zod';
import type { V2ClientPackage } from '../contracts/launch';
import { applyWorldAction, createWorld, worldSchema, type WorldAction } from './world';

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
export type V2Settings = z.infer<typeof settingsSchema>;
export const diagnosticsSchema = z.object({
  prompt: z.string().max(500_000), estimatedInputTokens: z.number(), outputBudget: z.number(),
  included: z.array(z.string()), omitted: z.array(z.string()),
  issues: z.array(z.string()), warnings: z.array(z.string()), model: z.string(), durationMs: z.number(),
  completionStatus: z.string(), worldRevision: z.number().int(),
  viewpointActorId: z.string().optional(), subjectActorId: z.string().nullable().optional(),
  resolutionStatus: z.enum(['authoritative-noop', 'deferred']).optional(),
  resolutionDeferredClaims: z.array(z.string()).optional(),
  providerKind: z.string().optional(), providerEndpoint: z.string().optional(), requestId: z.string().optional(),
  finishReason: z.string().optional(), requestedMaxTokens: z.number().optional(), providerInputTokensEstimate: z.number().optional(),
  generationSettings: generationSettingsSchema.optional(),
});
export type V2Diagnostics = z.infer<typeof diagnosticsSchema>;
export const turnSchema = z.object({
  id: z.string().min(1), player: z.string().min(1).max(16000), reply: z.string().min(1).max(64000),
  createdAt: z.number(), worldRevision: z.number().int(), diagnostics: diagnosticsSchema,
});
export type V2Turn = z.infer<typeof turnSchema>;
export const eventSchema = z.object({
  id: z.string().min(1), kind: z.enum(['operator', 'turn']), label: z.string().max(200),
  worldRevision: z.number().int(), at: z.number(), world: worldSchema.optional(),
});
export type V2Session = {
  version: 2; engine: 'v2'; id: string; launch: V2ClientPackage;
  world: z.infer<typeof worldSchema>; settings: V2Settings; draft: string;
  turns: V2Turn[]; events: z.infer<typeof eventSchema>[]; nextTurn: number;
};

export function createV2Session(launch: V2ClientPackage): V2Session {
  return {
    version: 2, engine: 'v2', id: crypto.randomUUID(), launch,
    world: createWorld(launch), settings: settingsSchema.parse({}), draft: '', turns: [], events: [], nextTurn: 1,
  };
}

export function operateWorld(session: V2Session, action: WorldAction, now = Date.now()): V2Session {
  const world = applyWorldAction(session.world, action, session.launch);
  return {
    ...session, world,
    events: [...session.events, { id: `operator:${world.revision}`, kind: 'operator', label: action.type, worldRevision: world.revision, at: now, world }],
  };
}

export function deleteLastTurn(session: V2Session): V2Session {
  const last = session.turns.at(-1);
  if (!last) return session;
  return { ...session, turns: session.turns.slice(0, -1), events: session.events.filter((event) => event.id !== last.id) };
}
