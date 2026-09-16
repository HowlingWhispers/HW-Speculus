import { z } from 'zod';
import type { CharacterCard, ClientLaunchPackage, OrbisLaunchPackage, SimulationAsset, SpeculusCatalogIdentity } from './types.js';

const assetSchema = z.object({
  id: z.string().trim().min(1).max(200),
  revision: z.string().trim().min(1).max(200),
  type: z.enum(['character', 'world', 'place', 'item', 'faction', 'other']),
  name: z.string().trim().min(1).max(200),
  summary: z.string().max(20_000).default(''),
  data: z.unknown(),
});

const characterSchema = z.object({
  kind: z.literal('character'), id: z.string().min(1), spec: z.literal('chara_card_v2'),
  name: z.string().min(1), description: z.string(), personality: z.string(), scenario: z.string(),
  firstMessage: z.string(), exampleDialogue: z.string(), systemPrompt: z.string(),
  postHistoryInstructions: z.string(), tags: z.array(z.string()),
});

const personaSchema = z.object({
  kind: z.literal('persona'), id: z.string().min(1), name: z.string().min(1), description: z.string(),
});

const catalogSchema = z.object({
  code: z.string().regex(/^(?:SPC|SPC#[1-9][0-9]*)-[A-Z]-[A-Z]{2}[0-9]{5}$/),
  prefix: z.string().regex(/^[A-Z]$/),
  plate: z.string().regex(/^[A-Z]{2}[0-9]{5}$/),
  generation: z.number().int().positive(),
  registryNumber: z.number().int().positive(),
  classRegistryNumber: z.number().int().positive(),
  classification: z.string().trim().min(1).max(80),
  createdAt: z.string().trim().min(10).max(64),
  status: z.enum(['active', 'archived', 'retired', 'sealed']),
});

export const orbisLaunchPackageSchema = z.object({
  version: z.literal(1),
  launchId: z.string().trim().min(8).max(200),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  initialLocationId: z.string().trim().min(1).max(200).optional(),
  catalog: catalogSchema.optional(),
  primaryAsset: assetSchema,
  relatedAssets: z.array(assetSchema).max(200).default([]),
  character: characterSchema.nullable().default(null),
  persona: personaSchema,
  scene: z.string().max(100_000),
  contextBlocks: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().max(300), content: z.string().max(100_000) })).max(500).default([]),
  relationshipState: z.record(z.string(), z.unknown()).default({}),
  model: z.string().trim().min(1).max(200),
  generationGrant: z.string().min(16).max(8192),
}).superRefine((value, context) => {
  if (value.expiresAt <= Date.now()) context.addIssue({ code: 'custom', message: 'Launch package has expired.' });
  else if (value.expiresAt <= value.issuedAt) context.addIssue({ code: 'custom', message: 'Launch package expiry must be later than its issue time.' });
  if (value.character && value.primaryAsset.type === 'character' && value.character.id !== value.primaryAsset.id) {
    context.addIssue({ code: 'custom', message: 'Primary character identity does not match the packaged character.' });
  }
  if (value.initialLocationId) {
    const assets = [value.primaryAsset, ...value.relatedAssets];
    if (!assets.some((asset) => asset.id === value.initialLocationId && asset.type === 'place')) {
      context.addIssue({ code: 'custom', message: 'Initial location must reference a packaged place.', path: ['initialLocationId'] });
    }
  }
  if (value.catalog) {
    const expected = value.catalog.generation === 1
      ? `SPC-${value.catalog.prefix}-${value.catalog.plate}`
      : `SPC#${value.catalog.generation}-${value.catalog.prefix}-${value.catalog.plate}`;
    if (value.catalog.code !== expected) context.addIssue({ code: 'custom', message: 'Speculus registry code does not match its class, generation, and plate.' });
    if (value.catalog.plate === 'AA68696') context.addIssue({ code: 'custom', message: 'Reserved Speculus registry plate was issued to an asset.' });
  }
});

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fallbackClass(asset: SimulationAsset) {
  if (asset.type === 'character') return { prefix: 'C', classification: 'CHARACTER' };
  if (asset.type === 'world') return { prefix: 'W', classification: 'WORLD' };
  if (asset.type === 'item') return { prefix: 'I', classification: 'ITEM' };
  if (asset.type === 'faction') return { prefix: 'F', classification: 'FACTION' };
  if (asset.type === 'place') {
    const kind = typeof recordValue(asset.data).kind === 'string' ? String(recordValue(asset.data).kind).toLowerCase() : '';
    if (/town|settlement|village|city|hamlet|enclave/.test(kind)) return { prefix: 'T', classification: 'TOWN / SETTLEMENT' };
    if (/building|structure|station|house|hall|temple|fort|castle/.test(kind)) return { prefix: 'B', classification: 'BUILDING / STRUCTURE' };
    return { prefix: 'P', classification: 'PLACE' };
  }
  return { prefix: 'X', classification: 'OTHER' };
}

function fallbackCatalog(asset: SimulationAsset): SpeculusCatalogIdentity {
  const { prefix, classification } = fallbackClass(asset);
  const compactId = asset.id.replace(/[^0-9a-f]/gi, '').padEnd(16, '0');
  const seedA = Number.parseInt(compactId.slice(0, 8), 16) || 0;
  const seedB = Number.parseInt(compactId.slice(8, 16), 16) || seedA;
  const first = String.fromCharCode(65 + (seedA % 26));
  const second = String.fromCharCode(65 + (Math.floor(seedA / 26) % 26));
  let number = (seedB % 99999) + 1;
  let plate = `${first}${second}${String(number).padStart(5, '0')}`;
  if (plate === 'AA68696') {
    number = number === 99999 ? 1 : number + 1;
    plate = `${first}${second}${String(number).padStart(5, '0')}`;
  }
  return {
    code: `SPC-${prefix}-${plate}`,
    prefix,
    plate,
    generation: 1,
    registryNumber: 0,
    classRegistryNumber: 0,
    classification,
    createdAt: '',
    status: 'legacy',
  };
}

export function resolveCatalogIdentity(value: ClientLaunchPackage): SpeculusCatalogIdentity {
  return value.catalog ?? fallbackCatalog(value.primaryAsset);
}

export function parseOrbisLaunchPackage(value: unknown): OrbisLaunchPackage {
  const result = orbisLaunchPackageSchema.safeParse(value);
  if (!result.success) throw new Error(`Orbis package rejected: ${result.error.issues[0]?.message ?? 'invalid package.'}`);
  return result.data as OrbisLaunchPackage;
}

export function clientLaunchPackage(value: OrbisLaunchPackage): ClientLaunchPackage {
  const { generationGrant: _secret, ...safe } = value;
  return safe;
}

export function parseClientLaunchPackage(value: unknown): ClientLaunchPackage {
  if (!value || typeof value !== 'object') throw new Error('Orbis package response is missing.');
  const parsed = parseOrbisLaunchPackage({ ...(value as Record<string, unknown>), generationGrant: 'client-redacted-grant' });
  return clientLaunchPackage(parsed);
}

export function resolveSimulationSubject(value: ClientLaunchPackage): CharacterCard {
  if (value.primaryAsset.type === 'character') {
    if (!value.character) throw new Error('Character primary asset is missing its Character Card V2 payload.');
    return value.character;
  }

  const asset = value.primaryAsset;
  return {
    kind: 'character',
    id: `speculus:narrator:${asset.id}`,
    spec: 'chara_card_v2',
    name: 'SIMULATION NARRATOR',
    description: `${asset.summary}\n\nPrimary entity type: ${asset.type}.\nPrimary entity name: ${asset.name}.`.trim(),
    personality: 'Neutral, observational, canon-bound simulation narrator.',
    scenario: value.scene,
    firstMessage: '',
    exampleDialogue: '',
    systemPrompt: [
      `Observe and simulate the packaged ${asset.type} named ${asset.name}.`,
      `The primary asset is a ${asset.type}, not a character. Do not give it speech, thoughts, feelings, motives, or relationships.`,
      'Only separately identified characters may speak, think, feel, or act as characters.',
      'Keep the selected asset central and never impersonate the player.',
    ].join(' '),
    postHistoryInstructions: '',
    tags: ['simulation-narrator', asset.type, 'orbis-packaged'],
  };
}
