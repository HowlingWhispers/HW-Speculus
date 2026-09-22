import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { clientLaunchPackage, parseOrbisLaunchPackage } from '../src/runtime/schema/launch-package.js';
import type { OrbisLaunchPackage } from '../src/runtime/schema/types.js';
import { generateThroughOrbis, type GenerationSession } from './providers/provider-service.js';
import { createV2Router } from './v2/router.js';
import { createV3Router } from './v3/router.js';

const generationRequestSchema = z.object({
  provider: z.literal('orbis'),
  prompt: z.string().min(1).max(500_000),
  model: z.string().trim().min(1).max(200),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(32).max(4096),
  topK: z.number().int().min(0).max(1000).default(250),
  topP: z.number().min(0).max(1).default(0.95),
  presencePenalty: z.number().min(-2).max(2).default(0),
  frequencyPenalty: z.number().min(-2).max(2).default(0),
  stopSequences: z.array(z.string().min(1).max(200)).max(16).default([]),
  continueToEndOfSentence: z.boolean().default(true),
  reroll: z.boolean().optional(),
});

const launchCodes = new Map<string, OrbisLaunchPackage>();
const SESSION_COOKIE = 'speculus_session';
const SESSION_VERSION = 1;

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request: Request): string {
  return request.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
}

function cookie(request: Request, name: string): string {
  const pair = (request.get('cookie') ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
}

function sessionKey(): Buffer {
  const secret = process.env.SPECULUS_BRIDGE_SECRET ?? '';
  if (!secret) throw new Error('Speculus bridge secret is not configured.');
  return createHash('sha256').update(`speculus-session-v${SESSION_VERSION}:${secret}`).digest();
}

function sealSession(session: GenerationSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify({ version: SESSION_VERSION, ...session }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function openSession(value: string): GenerationSession | null {
  if (!value) return null;
  try {
    const [ivValue, tagValue, ciphertextValue] = value.split('.');
    if (!ivValue || !tagValue || !ciphertextValue) return null;
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Partial<GenerationSession> & { version?: number };
    if (parsed.version !== SESSION_VERSION) return null;
    if (typeof parsed.launchId !== 'string' || typeof parsed.generationGrant !== 'string') return null;
    if (!parsed.source || typeof parsed.source.id !== 'string' || typeof parsed.source.revision !== 'string' || typeof parsed.source.type !== 'string') return null;
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) return null;
    return {
      launchId: parsed.launchId,
      generationGrant: parsed.generationGrant,
      source: parsed.source as GenerationSession['source'],
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, value] of launchCodes) if (value.expiresAt <= now) launchCodes.delete(key);
}

export function createApp(options: { production?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Archived V2 sessions may contain long transcripts. Keep the larger parser scoped
  // to the trusted Orbis launch deposit rather than widening generation/API bodies.
  app.use('/api/v2/launch', express.json({ limit: '18mb' }));
  app.use('/api/v3/launch', express.json({ limit: '18mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v2', createV2Router(options));
  app.use('/api/v3', createV3Router(options));
  app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'speculus-api', launchBridge: true }));

  app.post('/api/launch', (request, response, next) => {
    try {
      const bridgeSecret = process.env.SPECULUS_BRIDGE_SECRET ?? '';
      if (!bridgeSecret || !equalSecret(bearer(request), bridgeSecret)) return response.status(401).json({ error: 'Orbis bridge authorization failed.' });
      pruneExpired();
      const launchPackage = parseOrbisLaunchPackage(request.body);
      const code = randomUUID();
      launchCodes.set(code, launchPackage);
      const origin = (process.env.SPECULUS_PUBLIC_ORIGIN || 'https://spec.thehowlingwhispers.com').replace(/\/$/, '');
      response.status(201).json({ launchUrl: `${origin}/v1?launch=${encodeURIComponent(code)}`, expiresAt: launchPackage.expiresAt });
    } catch (error) { next(error); }
  });

  app.get('/api/launch/:code', (request, response, next) => {
    try {
      pruneExpired();
      const launchPackage = launchCodes.get(request.params.code);
      if (!launchPackage) return response.status(404).json({ error: 'Simulation package is missing, expired, or already claimed.' });
      launchCodes.delete(request.params.code);
      const generationSession: GenerationSession = {
        launchId: launchPackage.launchId,
        generationGrant: launchPackage.generationGrant,
        source: { id: launchPackage.primaryAsset.id, revision: launchPackage.primaryAsset.revision, type: launchPackage.primaryAsset.type },
        expiresAt: launchPackage.expiresAt,
      };
      const lifetime = Math.max(1, Math.floor((launchPackage.expiresAt - Date.now()) / 1000));
      response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sealSession(generationSession))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${lifetime}${options.production ? '; Secure' : ''}`);
      response.json({ package: clientLaunchPackage(launchPackage) });
    } catch (error) { next(error); }
  });

  app.post('/api/generate', async (request, response, next) => {
    try {
      pruneExpired();
      const session = openSession(cookie(request, SESSION_COOKIE));
      if (!session) return response.status(401).json({ error: 'No active Orbis simulation authorization. Launch the item again.' });
      const body = generationRequestSchema.parse(request.body);
      response.json(await generateThroughOrbis(session, body));
    } catch (error) { next(error); }
  });

  if (options.production) {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const webRoot = path.resolve(directory, '../../dist');
    app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
    app.get('*splat', (_request, response) => response.sendFile(path.join(webRoot, 'index.html')));
  }
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return response.status(400).json({ error: error.issues[0]?.message ?? 'Invalid request.' });
    const message = error instanceof Error ? error.message : 'Speculus bridge request failed.';
    response.status(502).json({ error: message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]') });
  });
  return app;
}
