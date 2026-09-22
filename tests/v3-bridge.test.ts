// @vitest-environment node
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { v2Package } from './v2-fixtures';

const servers: Server[] = [];

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
});

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function env() {
  vi.stubEnv('SPECULUS_BRIDGE_SECRET', 'test-v3-bridge-secret');
  vi.stubEnv('SPECULUS_PUBLIC_ORIGIN', 'https://spec.thehowlingwhispers.com');
}

function v3Package(launchId = 'fixture-v3-launch') {
  return { ...v2Package({ launchId }), version: 3 as const, engine: 'v3' as const };
}

const requestBody = (launchId: string) => ({
  launchId,
  provider: 'orbis',
  prompt: 'Render.',
  model: 'xialong-v1',
  temperature: 0.7,
  maxTokens: 512,
  topK: 30,
  topP: 0.8,
  presencePenalty: 0.1,
  frequencyPenalty: 0.2,
  stopSequences: [],
  continueToEndOfSentence: true,
});

describe('independent V3 bridge authorization', () => {
  it('owns the primary root launch URL and cannot cross-use V2 authorization', async () => {
    env();
    const base = await listen(createApp());

    const deposited = await post(base, '/api/v3/launch', v3Package(), {
      Authorization: 'Bearer test-v3-bridge-secret',
    });
    expect(deposited.status).toBe(201);

    const launchUrl = (await deposited.json() as { launchUrl: string }).launchUrl;
    expect(new URL(launchUrl).pathname).toBe('/');
    const code = new URL(launchUrl).searchParams.get('launch');
    expect(code).toBeTruthy();

    expect((await fetch(`${base}/api/v2/launch/${code}`)).status).toBe(404);

    const claimed = await fetch(`${base}/api/v3/launch/${code}`);
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get('set-cookie')).toMatch(/^speculus_v3_/);
    expect(claimed.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Path=/api/v3');
    expect(await claimed.text()).not.toContain('test-only-opaque-generation-grant');

    const cookie = claimed.headers.get('set-cookie')!.split(';')[0];
    expect((await post(base, '/api/v2/generate', requestBody('fixture-v3-launch'), { Cookie: cookie })).status).toBe(401);
  });

  it('generates through the V3 bridge with its own cookie scope', async () => {
    env();

    const gateway = express();
    gateway.use(express.json());
    const observed: Array<Record<string, unknown>> = [];
    gateway.post('/generate', (req, res) => {
      observed.push(req.body);
      res.json({ text: '"V3 online."', finishReason: 'stop' });
    });
    vi.stubEnv('ORBIS_GENERATION_API_URL', `${await listen(gateway)}/generate`);

    const base = await listen(createApp());
    const launchId = 'v3-independent-generation';
    const deposited = await post(base, '/api/v3/launch', v3Package(launchId), {
      Authorization: 'Bearer test-v3-bridge-secret',
    });
    const launchUrl = (await deposited.json() as { launchUrl: string }).launchUrl;
    const code = new URL(launchUrl).searchParams.get('launch');
    const claimed = await fetch(`${base}/api/v3/launch/${code}`);
    const cookie = claimed.headers.get('set-cookie')!.split(';')[0];

    const response = await post(base, '/api/v3/generate', requestBody(launchId), { Cookie: cookie });
    expect(response.status).toBe(200);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ launchId, maxTokens: 512, temperature: 0.7 });
  });
});
