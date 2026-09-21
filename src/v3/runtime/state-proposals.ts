import { z } from 'zod';

const id = z.string().min(1).max(300);

export const stateProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    id,
    sourceTurnId: id,
    kind: z.literal('inventory-add'),
    summary: z.string().min(1).max(1000),
    canonicalItemId: id,
    ownerActorId: id,
    quantity: z.number().int().positive().max(1_000_000).default(1),
  }),
  z.object({
    id,
    sourceTurnId: id,
    kind: z.literal('inventory-remove'),
    summary: z.string().min(1).max(1000),
    instanceId: id,
  }),
  z.object({
    id,
    sourceTurnId: id,
    kind: z.literal('inventory-set-equipped'),
    summary: z.string().min(1).max(1000),
    instanceId: id,
    equipped: z.boolean(),
  }),
]);

export const stateProposalsSchema = z.array(stateProposalSchema).max(5000).default([]);
export type V3StateProposal = z.infer<typeof stateProposalSchema>;
