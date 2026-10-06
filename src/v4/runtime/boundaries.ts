import { z } from 'zod';
import { diagnosticsSchema, eventSchema, relationshipStateSchema, sessionStateProposalsSchema, type V4Session } from './session';
import { worldSchema } from './world';
import { V4_RESOLUTION_SCHEMA } from './resolution';
import { runtimeDomainsSchema } from './state-domains';
import type { V4Branch } from './branches';

export const snapshotSchema = z.object({
  world: worldSchema.extend({
    simulationDay: worldSchema.shape.simulationDay.removeDefault(), timeOfDaySeconds: worldSchema.shape.timeOfDaySeconds.removeDefault(),
    domains: runtimeDomainsSchema.safeExtend({
      inventory: runtimeDomainsSchema.shape.inventory.removeDefault(), relationships: runtimeDomainsSchema.shape.relationships.removeDefault(),
      resources: runtimeDomainsSchema.shape.resources.removeDefault(), conditions: runtimeDomainsSchema.shape.conditions.removeDefault(),
      mysteries: runtimeDomainsSchema.shape.mysteries.removeDefault(), chronicle: runtimeDomainsSchema.shape.chronicle.removeDefault(),
    }),
  }), relationships: relationshipStateSchema.removeDefault(), stateProposals: sessionStateProposalsSchema.removeDefault(),
  events: z.array(eventSchema).max(40000), nextTurn: z.number().int().positive(),
});
export type V4Snapshot = z.infer<typeof snapshotSchema>;
const perceptionSchema = z.object({
  locationId: z.string().nullable(), presentActors: z.array(z.object({ id: z.string(), name: z.string() })),
  knownFacts: z.array(z.string()), limitations: z.array(z.string()),
});
export const resolutionSchema = z.object({
  schemaVersion: z.literal(V4_RESOLUTION_SCHEMA), status: z.enum(['authoritative-noop', 'resolved', 'deferred']),
  playerActorId: z.string().min(1), subjectActorId: z.string().nullable(),
  worldRevisionBefore: z.number().int().nonnegative(), worldRevisionAfter: z.number().int().nonnegative(),
  elapsedSeconds: z.number().int().nonnegative(), appliedActions: z.array(z.string()), deferredClaims: z.array(z.string()),
  narrativeCheck: diagnosticsSchema.shape.resolutionCheck,
  travel: z.object({
    kind: z.literal('resolved'), originId: z.string(), originName: z.string(), destinationId: z.string(), destinationName: z.string(),
    distanceKm: z.number().finite().nonnegative(), seconds: z.number().int().nonnegative(), mode: z.enum(['onFoot', 'mounted', 'cart']),
    routeBasis: z.enum(['direct-reference', 'local', 'via-hollowmere']),
  }).optional(),
  playerPerception: perceptionSchema, subjectPerception: perceptionSchema.nullable(),
});

export function captureSnapshot(session: V4Session): V4Snapshot {
  return structuredClone({ world: session.world, relationships: session.relationships, stateProposals: session.stateProposals,
    events: session.events, nextTurn: session.nextTurn });
}

// Object key ordering is not authoritative, but ledger/turn ordering is.
export function sameState(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameState(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length
    && keys.every((key) => Object.hasOwn(b, key) && sameState(a[key], b[key]));
}

export function reconstructAfterTurn(branch: V4Branch, turnId: string, pageId?: string): V4Snapshot {
  const turn = branch.turns.find((value) => value.id === turnId);
  if (!turn) throw new Error('Fork turn is not in this branch.');
  const page = turn.pages.find((value) => value.id === (pageId ?? turn.activePageId));
  if (!page?.after || !page.before || !page.resolved || !page.resolution) throw new Error('Historical boundary is unverifiable.');
  if (page.id !== turn.activePageId) throw new Error('Inactive page continuation is not implemented.');
  let snapshot = page.after;
  for (const operation of branch.operations.filter((value) => value.turnId === turn.id)) {
    if (operation.pageId !== page.id || !sameState(operation.before, snapshot)) throw new Error('Operation boundary linkage is inconsistent.');
    snapshot = operation.after;
  }
  return structuredClone(snapshot);
}
