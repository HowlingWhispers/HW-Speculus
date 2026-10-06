import { z } from 'zod';
import type { V4ClientPackage } from '../contracts/launch';
import { branchSchema, branchSourceFor, createRootBranch, projectBranch, type V4Branch } from '../runtime/branches';
import { sameState } from '../runtime/boundaries';
import { createV4Session, relationshipStateSchema, sessionStateProposalsSchema } from '../runtime/session';
import { assertWorldCanon, worldSchema } from '../runtime/world';
import { importV4Session, MAX_V4_FILE_BYTES, SpeculusImportError, V4_EXPORT_FORMAT } from './session';

const identity = z.object({ id: z.string().min(1) });
const sourceSchema = z.object({
  id: z.string().min(1), type: z.string().min(1), revision: z.string().min(1),
  persona: identity, character: identity.nullable(),
});
const transferSchema = z.object({
  format: z.literal(V4_EXPORT_FORMAT), version: z.literal(4), engine: z.literal('v4'), schemaVersion: z.literal(4),
  source: sourceSchema, branch: branchSchema,
});
const forbiddenKey = /^(?:launch|launchid|generationgrant|grant|grants|expiresat|authorization|authorizations|proxyauthorization|auth|bearer|cookie|cookies|setcookie|sessioncookie|credential|credentials|providercredentials|providerkey|apikey|accesstoken|refreshtoken|providertoken|token|password|secret|bridgesecret|privatekey)$/i;
const bearer = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const authorization = /\b(?:authorization|api[-_ ]?key|(?:access|refresh|provider)[-_ ]?token|token|generation[-_ ]?grant|launch[-_ ]?id|cookie|password|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;"'&]+/gi;

function sourceFor(branch: V4Branch) {
  const source = branch.source;
  return { id: source.sourceId, type: source.sourceType, revision: source.sourceRevision,
    persona: { id: source.personaId }, character: source.subjectId === null ? null : { id: source.subjectId } };
}

function assertSafe(value: unknown, secrets: string[] = []): void {
  if (typeof value === 'string') {
    if (value.match(bearer) || value.match(authorization) || secrets.some((secret) => value.includes(secret))) {
      throw new SpeculusImportError('Authorization-bearing data is not allowed in branch files.');
    }
  } else if (Array.isArray(value)) value.forEach((item) => assertSafe(item, secrets));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKey.test(key.replace(/[^a-z0-9]/gi, ''))) throw new SpeculusImportError('Authorization-bearing fields are not allowed in branch files.');
      assertSafe(item, secrets);
    }
  }
}

function parseJson(raw: string): Record<string, unknown> {
  if (new Blob([raw]).size > MAX_V4_FILE_BYTES) throw new SpeculusImportError('Branch file exceeds 16 MB. No history was pruned.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SpeculusImportError('Branch file is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpeculusImportError('Unrecognized Speculus branch file.');
  assertSafe(value);
  return value as Record<string, unknown>;
}

function canonicalTransfer(value: Record<string, unknown>) {
  const transfer = transferSchema.parse(value);
  if (!sameState(transfer.source, sourceFor(transfer.branch))) throw new SpeculusImportError('Branch source metadata is inconsistent.');
  return transfer;
}

export function inspectBranchFile(raw: string) {
  const value = parseJson(raw);
  if ('branch' in value || 'schemaVersion' in value) return canonicalTransfer(value).source;
  if (!((value.format === V4_EXPORT_FORMAT && value.version === 4 && value.engine === 'v4')
    || (value.format === 'speculus-v2-session' && value.version === 2 && value.engine === 'v2'))) {
    throw new SpeculusImportError('Unrecognized Speculus branch file.');
  }
  return sourceSchema.parse(value.source);
}

export function exportBranch(branch: V4Branch, launch?: V4ClientPackage): string {
  const valid = branchSchema.parse(branch);
  if (launch) projectBranch(valid, launch);
  const secrets = launch ? [launch.launchId, ...Object.entries(launch)
    .filter(([key, value]) => forbiddenKey.test(key.replace(/[^a-z0-9]/gi, '')) && typeof value === 'string').map(([, value]) => value as string)]
    .filter((value) => value.length > 0) : [];
  // Diagnostic/provider strings are untrusted transport output, not story authority.
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value.replace(authorization, '[redacted]').replace(bearer, '[redacted]');
      for (const secret of secrets) text = text.split(secret).join('[redacted]');
      return text;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !forbiddenKey.test(key.replace(/[^a-z0-9]/gi, ''))).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  for (const turn of valid.turns) for (const page of turn.pages) page.diagnostics = redact(page.diagnostics) as typeof page.diagnostics;
  const safe = branchSchema.parse(valid);
  if (launch) projectBranch(safe, launch);
  const transfer = { format: V4_EXPORT_FORMAT, version: 4, engine: 'v4', schemaVersion: 4, source: sourceFor(safe), branch: safe };
  assertSafe(transfer, secrets);
  const raw = JSON.stringify(transfer, null, 2);
  if (new Blob([raw]).size > MAX_V4_FILE_BYTES) throw new SpeculusImportError('Branch export exceeds 16 MB. No history was pruned.');
  return raw;
}

export function importBranchFile(raw: string, launch: V4ClientPackage): V4Branch {
  const value = parseJson(raw);
  const source = inspectBranchFile(raw);
  const expected = branchSourceFor(launch);
  if (!sameState(source, { id: expected.sourceId, type: expected.sourceType, revision: expected.sourceRevision,
    persona: { id: expected.personaId }, character: expected.subjectId === null ? null : { id: expected.subjectId } })) {
    throw new SpeculusImportError('Branch source requires the exact canonical record, revision, persona and subject.');
  }
  if ('branch' in value || 'schemaVersion' in value) {
    const branch = canonicalTransfer(value).branch;
    projectBranch(branch, launch);
    return branch;
  }
  // Validate the original authority before the copied flat reader can reconcile actors.
  const world = worldSchema.parse(value.world);
  assertWorldCanon(world, launch);
  const eventWorlds = new Map<number, z.infer<typeof worldSchema>>();
  if (Array.isArray(value.events)) value.events.forEach((event, index) => {
    if (event && typeof event === 'object' && 'world' in event && event.world !== undefined) {
      const original = worldSchema.parse(event.world); assertWorldCanon(original, launch); eventWorlds.set(index, original);
    }
  });
  for (const [key, schema] of [['relationships', relationshipStateSchema], ['stateProposals', sessionStateProposalsSchema]] as const) {
    if (value[key] !== undefined && !sameState(value[key], schema.parse(value[key]))) {
      throw new SpeculusImportError(`Incomplete authoritative ${key} cannot be repaired during migration.`);
    }
  }
  const current = createV4Session(launch);
  // The copied flat reader requires display names; they are not source identity.
  const flatSource = value.source as Record<string, unknown>;
  const session = importV4Session(JSON.stringify({ ...value, source: { ...flatSource,
    persona: { name: launch.persona.name, ...(flatSource.persona as object) },
    character: source.character === null ? null : { name: launch.character?.name ?? '', ...(flatSource.character as object) },
  } }), current);
  session.world = world;
  session.events = session.events.map((event, index) => eventWorlds.has(index) ? { ...event, world: eventWorlds.get(index)! } : event);
  if (typeof value.id === 'string' && value.id.length) session.id = value.id;
  const branch = createRootBranch(session);
  projectBranch(branch, launch);
  return branch;
}

export function branchExportFilename(branch: V4Branch): string {
  const clean = (value: string) => value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'branch';
  return `Speculus_V4_${clean(branch.label)}_${clean(branch.storyId)}_${clean(branch.branchId)}.json`;
}
