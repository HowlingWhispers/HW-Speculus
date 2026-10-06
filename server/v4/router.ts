import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { publicV4Package, v4LaunchSchema, type V4LaunchPackage } from '../../src/v4/contracts/launch.js';
import { generateThroughOrbis, type GenerationSession } from '../providers/provider-service.js';

const generationSchema = z.object({
  launchId: z.string().min(8).max(200), provider: z.literal('orbis'),
  prompt: z.string().min(1).max(500_000), model: z.string().min(1).max(200),
  temperature: z.number().min(0).max(2), maxTokens: z.number().int().min(32).max(4096),
  topK: z.number().int().min(0).max(1000), topP: z.number().min(0).max(1),
  presencePenalty: z.number().min(-2).max(2), frequencyPenalty: z.number().min(-2).max(2),
  stopSequences: z.array(z.string().min(1).max(200)).max(16),
  continueToEndOfSentence: z.boolean(), reroll: z.boolean().optional(),
});
const researchRetractionSchema = z.object({
  launchId: z.string().min(8).max(200),
  sessionId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
});
const researchObservationSchema = researchRetractionSchema.extend({
  occurredAt: z.number().int().positive().safe(),
  player: z.string().min(1).max(16000), reply: z.string().min(1).max(64000),
  worldRevision: z.number().int().nonnegative(), locationId: z.string().max(200).nullable(),
  reroll: z.boolean().default(false), engine: z.literal('v4').default('v4'),
});

const resumeSourceSchema = z.object({
  id: z.string().min(1).max(200), type: z.string().min(1).max(40), revision: z.string().min(1).max(200),
}).passthrough();
const resumeSaveSchema = z.union([
  z.object({ format: z.literal('speculus-v4-session'), version: z.literal(4), engine: z.literal('v4'), source: resumeSourceSchema }).passthrough(),
  // V3 exports retain the version-2 save identity.
  z.object({ format: z.literal('speculus-v2-session'), version: z.literal(2), engine: z.literal('v2'), source: resumeSourceSchema }).passthrough(),
]).superRefine((value, context) => {
  // Check the entire raw save, including unknown metadata and nested arrays.
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    for (const [name, child] of Object.entries(item)) {
      const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (/^(launchid|generationgrant|expiresat|authorization|authorizations|auth|bearer|cookie|cookies|setcookie|credential|credentials|providercredentials|providerkey|providertoken|apikey|accesstoken|refreshtoken|token|secret|bridgesecret|sessioncookie|password|privatekey)$/.test(normalized)) {
        context.addIssue({ code: 'custom', message: 'Resume saves must be authorization-free.' });
        return;
      }
      pending.push(child);
    }
  }
});
const launchDepositSchema = z.object({ package: v4LaunchSchema, resumeSave: resumeSaveSchema.optional() }).superRefine((value, context) => {
  if (!value.resumeSave) return;
  const source = value.resumeSave.source;
  const primary = value.package.primaryAsset;
  if (source.id !== primary.id || source.type !== primary.type || source.revision !== primary.revision) {
    context.addIssue({ code: 'custom', message: 'Resume save does not match the fresh V4 launch source revision.', path: ['resumeSave', 'source'] });
  }
});

type V4Authorization = GenerationSession & { version: 4; model: string; worldId: string | null };
type V4Deposit = z.infer<typeof launchDepositSchema>;
const cookieName = (id: string) => `speculus_v4_${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const key = () => createHash('sha256').update(`speculus-v4-authorization:${process.env.SPECULUS_BRIDGE_SECRET}`).digest();

function packagedWorldId(value: V4LaunchPackage): string | null {
  return [value.primaryAsset, ...value.relatedAssets].find((asset) => asset.type === 'world')?.id ?? null;
}
function clip(value: string, max: number): string {
  const clean = value.replace(/\u0000/g, '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}
function seal(value: V4Authorization): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}
function authorization(request: Request, id: string): V4Authorization | null {
  if (!process.env.SPECULUS_BRIDGE_SECRET) return null;
  try {
    const prefix = `${cookieName(id)}=`;
    const value = (request.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    if (!value) return null;
    const [iv, tag, data] = value.slice(prefix.length).split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    const session = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as V4Authorization;
    return session.version === 4 && session.launchId === id && session.expiresAt > Date.now() ? session : null;
  } catch { return null; }
}

export function createV4Router(options: { production?: boolean } = {}) {
  const router = Router();
  const deposits = new Map<string, V4Deposit>();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    for (const [code, value] of deposits) if (value.package.expiresAt <= Date.now()) deposits.delete(code);
    next();
  });
  router.post('/launch', (request, response, next) => {
    try {
      const expected = Buffer.from(process.env.SPECULUS_BRIDGE_SECRET ?? '');
      const actual = Buffer.from(request.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
      if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return response.status(401).json({ error: 'Orbis bridge authorization failed.' });
      }
      // The launch wire contract remains version 2; runtime/resume identity is V4.
      const parsed = request.body && typeof request.body === 'object' && 'package' in request.body
        ? launchDepositSchema.parse(request.body) : launchDepositSchema.parse({ package: request.body });
      const code = randomUUID();
      deposits.set(code, parsed);
      const origin = (process.env.SPECULUS_PUBLIC_ORIGIN || 'https://spec.thehowlingwhispers.com').replace(/\/$/, '');
      response.status(201).json({ launchUrl: `${origin}/v4?launch=${encodeURIComponent(code)}`, expiresAt: parsed.package.expiresAt });
    } catch (error) { next(error); }
  });
  router.get('/launch/:code', (request, response) => {
    const deposit = deposits.get(String(request.params.code));
    if (!deposit) return response.status(404).json({ error: 'V4 package is missing, expired, or already claimed. Launch again from Orbis.' });
    deposits.delete(String(request.params.code));
    const value = deposit.package;
    const session: V4Authorization = {
      version: 4, launchId: value.launchId, generationGrant: value.generationGrant, model: value.model,
      source: { id: value.primaryAsset.id, type: value.primaryAsset.type, revision: value.primaryAsset.revision },
      worldId: packagedWorldId(value), expiresAt: value.expiresAt,
    };
    const lifetime = Math.max(1, Math.floor((value.expiresAt - Date.now()) / 1000));
    response.setHeader('Set-Cookie', `${cookieName(value.launchId)}=${seal(session)}; HttpOnly; SameSite=Strict; Path=/api/v4; Max-Age=${lifetime}${options.production ? '; Secure' : ''}`);
    response.json({ package: publicV4Package(value), ...(deposit.resumeSave ? { resumeSave: deposit.resumeSave } : {}) });
  });
  router.post('/research/retract', async (request, response, next) => {
    try {
      const expectedOrigin = (process.env.SPECULUS_PUBLIC_ORIGIN || 'https://spec.thehowlingwhispers.com').replace(/\/$/, '');
      if (options.production && request.get('origin') !== expectedOrigin) return response.status(403).json({ error: 'Invalid V4 request origin.' });
      const body = researchRetractionSchema.parse(request.body);
      const session = authorization(request, body.launchId);
      if (!session) return response.status(401).json({ error: 'V4 authorization expired. Launch this record again from Orbis.' });
      const studiumBase = (process.env.STUDIUM_API_URL ?? '').trim().replace(/\/$/, '');
      const studiumSecret = process.env.STUDIUM_BRIDGE_SECRET ?? '';
      if (!studiumBase || !studiumSecret) return response.status(202).json({ ok: true, retracted: false, reason: 'studium_disabled' });
      const bundleId = `speculus:${body.sessionId}:${body.turnId}`;
      const upstream = await fetch(`${studiumBase}/api/v1/bundles/${encodeURIComponent(bundleId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${studiumSecret}` }, signal: AbortSignal.timeout(5000),
      });
      if (upstream.status === 404) return response.status(202).json({ ok: true, retracted: false, reason: 'not_found', bundleId });
      if (!upstream.ok) return response.status(502).json({ error: `Studium retraction returned HTTP ${upstream.status}.` });
      return response.status(202).json({ ok: true, retracted: true, bundleId });
    } catch (error) { next(error); }
  });
  router.post('/research', async (request, response, next) => {
    try {
      const expectedOrigin = (process.env.SPECULUS_PUBLIC_ORIGIN || 'https://spec.thehowlingwhispers.com').replace(/\/$/, '');
      if (options.production && request.get('origin') !== expectedOrigin) return response.status(403).json({ error: 'Invalid V4 request origin.' });
      const body = researchObservationSchema.parse(request.body);
      const session = authorization(request, body.launchId);
      if (!session) return response.status(401).json({ error: 'V4 authorization expired. Launch this record again from Orbis.' });
      const studiumBase = (process.env.STUDIUM_API_URL ?? '').trim().replace(/\/$/, '');
      const studiumSecret = process.env.STUDIUM_BRIDGE_SECRET ?? '';
      if (!studiumBase || !studiumSecret) return response.status(202).json({ ok: true, forwarded: false, reason: 'studium_disabled' });
      if (!session.worldId) return response.status(202).json({ ok: true, forwarded: false, reason: 'world_not_packaged' });
      const recordId = `speculus:${body.engine}:${body.sessionId}:${body.turnId}`;
      const bundle = {
        schemaVersion: 'studium.bundle.v1', bundleId: `speculus:${body.sessionId}:${body.turnId}`,
        worldId: session.worldId, source: 'speculus', capturedAt: new Date().toISOString(), sanitized: true,
        records: [{
          recordId, occurredAt: new Date(body.occurredAt).toISOString(), kind: `speculus_${body.engine}_turn`,
          summary: `PLAYER TURN\n${clip(body.player, 1800)}\n\nSIMULATION REPLY\n${clip(body.reply, 1800)}`,
          evidence: [`Player: ${clip(body.player, 900)}`, `Simulation: ${clip(body.reply, 900)}`], signals: [],
          tags: [`speculus-${body.engine}`, `source:${session.source.type}`, body.reroll ? 'reroll' : 'committed-turn',
            ...(body.locationId && body.locationId.length <= 80 ? [`location:${body.locationId}`] : [])],
        }],
      };
      const upstream = await fetch(`${studiumBase}/api/v1/bundles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studiumSecret}` },
        body: JSON.stringify(bundle), signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) return response.status(502).json({ error: `Studium ingestion returned HTTP ${upstream.status}.` });
      return response.status(202).json({ ok: true, forwarded: true, worldId: session.worldId, recordId });
    } catch (error) { next(error); }
  });
  router.post('/generate', async (request, response, next) => {
    try {
      const expected = (process.env.SPECULUS_PUBLIC_ORIGIN || 'https://spec.thehowlingwhispers.com').replace(/\/$/, '');
      if (options.production && request.get('origin') !== expected) return response.status(403).json({ error: 'Invalid V4 request origin.' });
      const body = generationSchema.parse(request.body);
      const session = authorization(request, body.launchId);
      if (!session) return response.status(401).json({ error: 'V4 authorization expired. Launch this record again from Orbis.' });
      if (body.model !== session.model) return response.status(403).json({ error: 'Model does not match the authorized V4 launch.' });
      response.json(await generateThroughOrbis(session, body));
    } catch (error) { next(error); }
  });
  return router;
}
