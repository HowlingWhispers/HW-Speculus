import { z } from 'zod';

const id = z.string().min(1).max(200);

export const inventoryItemStateSchema = z.object({
  instanceId: id,
  canonicalItemId: id,
  ownerActorId: id.nullable(),
  containerId: id.nullable().default(null),
  quantity: z.number().int().positive().safe(),
  equipped: z.boolean().default(false),
  condition: z.number().min(0).max(1).nullable().default(null),
});

export const relationshipEventSchema = z.object({
  id,
  kind: z.string().min(1).max(80),
  summary: z.string().min(1).max(2000),
  atElapsedSeconds: z.number().int().nonnegative().safe(),
  ownerTurnId: id.nullable().default(null),
});

export const relationshipStateSchema = z.object({
  id,
  actorIds: z.tuple([id, id]),
  stage: z.string().max(120).nullable().default(null),
  factors: z.record(z.string().min(1).max(80), z.number().finite()).default({}),
  events: z.array(relationshipEventSchema).max(1000).default([]),
}).superRefine((value, context) => {
  if (value.actorIds[0] === value.actorIds[1]) {
    context.addIssue({ code: 'custom', message: 'A relationship requires two different actors.', path: ['actorIds'] });
  }
});

export const resourceStateSchema = z.object({
  id,
  definitionId: id,
  ownerActorId: id.nullable(),
  value: z.number().finite(),
  maximum: z.number().finite().nullable().default(null),
});

export const conditionStateSchema = z.object({
  id,
  definitionId: id,
  actorId: id,
  severity: z.number().min(0).max(1).nullable().default(null),
  ownerTurnId: id.nullable().default(null),
});

export const mysteryStateSchema = z.object({
  id,
  mysteryId: id,
  stageIndex: z.number().int().nonnegative().safe().default(0),
  knownByActorIds: z.array(id).max(200).default([]),
  revealedFactIds: z.array(id).max(2000).default([]),
});

export const chronicleEntrySchema = z.object({
  id,
  tier: z.enum(['scene', 'chronicle', 'recap', 'archive']),
  summary: z.string().min(1).max(20_000),
  atElapsedSeconds: z.number().int().nonnegative().safe(),
  sourceTurnIds: z.array(id).max(200).default([]),
});

const uniqueValues = <T>(items: T[], valueOf: (item: T) => string, context: z.RefinementCtx, path: string) => {
  if (new Set(items.map(valueOf)).size !== items.length) {
    context.addIssue({ code: 'custom', message: `Duplicate ${path} identities are not allowed.`, path: [path] });
  }
};

export const runtimeDomainsSchema = z.object({
  inventory: z.array(inventoryItemStateSchema).max(20_000).default([]),
  relationships: z.array(relationshipStateSchema).max(10_000).default([]),
  resources: z.array(resourceStateSchema).max(10_000).default([]),
  conditions: z.array(conditionStateSchema).max(10_000).default([]),
  mysteries: z.array(mysteryStateSchema).max(5000).default([]),
  chronicle: z.array(chronicleEntrySchema).max(20_000).default([]),
}).superRefine((value, context) => {
  uniqueValues(value.inventory, (item) => item.instanceId, context, 'inventory');
  uniqueValues(value.relationships, (item) => item.id, context, 'relationships');
  uniqueValues(value.resources, (item) => item.id, context, 'resources');
  uniqueValues(value.conditions, (item) => item.id, context, 'conditions');
  uniqueValues(value.mysteries, (item) => item.id, context, 'mysteries');
  uniqueValues(value.chronicle, (item) => item.id, context, 'chronicle');
});

export type V3RuntimeDomains = z.infer<typeof runtimeDomainsSchema>;

export function emptyRuntimeDomains(): V3RuntimeDomains {
  return runtimeDomainsSchema.parse({});
}
