// @vitest-environment node
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { v2Package } from './v2-fixtures';

const servers: Server[] = [];
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
});
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const auth = { Authorization: 'Bearer test-v2-bridge-secret' };
function env() { vi.stubEnv('SPECULUS_BRIDGE_SECRET', 'test-v2-bridge-secret'); vi.stubEnv('SPECULUS_PUBLIC_ORIGIN', 'https://spec.thehowlingwhispers.com'); }
const requestBody = (launchId: string) => ({ launchId, provider: 'orbis', prompt: 'Render.', model: 'xialong-v1', temperature: 0.7, maxTokens: 1024, topK: 30, topP: 0.8, presencePenalty: 0.1, frequencyPenalty: 0.2, stopSequences: ['STOP'], continueToEndOfSentence: false });
async function deposit(base: string, version: 1 | 2, launchId = `fixture-launch-${version}`) {
  const body = { ...v2Package(), version, launchId };
  const response = await post(base, version === 2 ? '/api/v2/launch' : '/api/launch', body, auth);
  expect(response.status).toBe(201);
  const result = await response.json() as { launchUrl: string };
  return { code: new URL(result.launchUrl).searchParams.get('launch'), url: result.launchUrl };
}

describe('separate V1/V2 bridge authorization', () => {
  it('keeps deposits, one-time claims, URLs and HTTP-only cookies separate', async () => {
    env(); const base = await listen(createApp());
    const one = await deposit(base, 1); const two = await deposit(base, 2);
    expect(new URL(one.url).pathname).toBe('/v1'); expect(new URL(two.url).pathname).toBe('/v2');
    expect((await fetch(`${base}/api/launch/${two.code}`)).status).toBe(404);
    expect((await fetch(`${base}/api/v2/launch/${one.code}`)).status).toBe(404);
    const v1 = await fetch(`${base}/api/launch/${one.code}`);
    const v2 = await fetch(`${base}/api/v2/launch/${two.code}`);
    expect(v1.status).toBe(200); expect(v2.status).toBe(200);
    expect(v1.headers.get('set-cookie')).toMatch(/^speculus_session=/);
    expect(v2.headers.get('set-cookie')).toMatch(/^speculus_v2_/);
    expect(v2.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Path=/api/v2');
    expect(v2.headers.get('cache-control')).toBe('no-store');
    expect(await v2.text()).not.toContain('test-only-opaque-generation-grant');
    expect((await fetch(`${base}/api/v2/launch/${two.code}`)).status).toBe(404);
    const v1cookie = v1.headers.get('set-cookie')!.split(';')[0];
    const v2cookie = v2.headers.get('set-cookie')!.split(';')[0];
    expect((await post(base, '/api/v2/generate', requestBody('fixture-launch-2'), { Cookie: v1cookie })).status).toBe(401);
    expect((await post(base, '/api/generate', requestBody('fixture-launch-1'), { Cookie: v2cookie })).status).toBe(401);
  });
  it('rejects unsigned, expired and wrong-version deposits', async () => {
    env(); const base = await listen(createApp());
    expect((await post(base, '/api/v2/launch', v2Package())).status).toBe(401);
    expect((await post(base, '/api/v2/launch', { ...v2Package(), version: 1 }, auth)).status).toBe(400);
    expect((await post(base, '/api/v2/launch', { ...v2Package(), expiresAt: 1 }, auth)).status).toBe(400);
    expect((await post(base, '/api/launch', v2Package(), auth)).status).not.toBe(201);
  });
  it('binds simultaneous V2 launches to their own cookie and forwards native settings', async () => {
    env(); const gateway = express(); gateway.use(express.json());
    const observed: Array<Record<string, unknown>> = [];
    gateway.post('/generate', (req, res) => { observed.push(req.body); res.json({ text: '"Hello."', finishReason: 'stop' }); });
    vi.stubEnv('ORBIS_GENERATION_API_URL', `${await listen(gateway)}/generate`);
    const base = await listen(createApp());
    const one = await deposit(base, 2, 'separate-launch-one'); const two = await deposit(base, 2, 'separate-launch-two');
    const response1 = await fetch(`${base}/api/v2/launch/${one.code}`); const response2 = await fetch(`${base}/api/v2/launch/${two.code}`);
    const cookie1 = response1.headers.get('set-cookie')!.split(';')[0]; const cookie2 = response2.headers.get('set-cookie')!.split(';')[0];
    expect(cookie1.split('=')[0]).not.toBe(cookie2.split('=')[0]);
    expect((await post(base, '/api/v2/generate', requestBody('separate-launch-two'), { Cookie: cookie1 })).status).toBe(401);
    const cookies = `${cookie1}; ${cookie2}`;
    for (const id of ['separate-launch-one', 'separate-launch-two']) expect((await post(base, '/api/v2/generate', requestBody(id), { Cookie: cookies })).status).toBe(200);
    expect(observed.map((value) => value.launchId)).toEqual(['separate-launch-one', 'separate-launch-two']);
    expect(observed[0]).toMatchObject({ maxTokens: 1024, temperature: 0.7, topK: 30, topP: 0.8, presencePenalty: 0.1, frequencyPenalty: 0.2, stopSequences: ['STOP'], continueToEndOfSentence: false });
    expect((await post(base, '/api/v2/generate', { ...requestBody('separate-launch-one'), model: 'glm-4-6' }, { Cookie: cookies })).status).toBe(403);
    expect(observed).toHaveLength(2);
  });

  it('forwards sanitized committed V2 turns to Studium using the packaged world identity', async () => {
    env();

    const observed: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
    const studium = express();
    studium.use(express.json());
    studium.post('/api/v1/bundles', (req, res) => {
      observed.push({ headers: req.headers, body: req.body });
      res.status(201).json({ ok: true, inserted: true });
    });
    vi.stubEnv('STUDIUM_API_URL', await listen(studium));
    vi.stubEnv('STUDIUM_BRIDGE_SECRET', 'test-studium-bridge-secret');

    const base = await listen(createApp());
    const launchId = 'studium-v2-launch';
    const packageValue = v2Package({
      launchId,
      relatedAssets: [
        { id: 'world:test-world', type: 'world', revision: 'world-rev-1', name: 'Test World', summary: 'Fixture world.', data: {} },
        { id: 'place:workshop', type: 'place', revision: 'rev-1', name: 'Workshop', summary: 'A quiet workshop.', data: {} },
      ],
    });
    const deposited = await post(base, '/api/v2/launch', packageValue, auth);
    expect(deposited.status).toBe(201);
    const launchUrl = (await deposited.json() as { launchUrl: string }).launchUrl;
    const code = new URL(launchUrl).searchParams.get('launch');
    const claimed = await fetch(`${base}/api/v2/launch/${code}`);
    const cookie = claimed.headers.get('set-cookie')!.split(';')[0];

    const research = await post(base, '/api/v2/research', {
      launchId,
      sessionId: 'session-fixture',
      turnId: 'turn:1',
      occurredAt: Date.now(),
      player: '*I walk into the workshop.*',
      reply: '*The workshop door opens with a dry wooden creak.*',
      worldRevision: 1,
      locationId: 'place:workshop',
      reroll: false,
    }, { Cookie: cookie });

    expect(research.status).toBe(202);
    expect(observed).toHaveLength(1);
    expect(observed[0].headers.authorization).toBe('Bearer test-studium-bridge-secret');
    expect(observed[0].body).toMatchObject({
      schemaVersion: 'studium.bundle.v1',
      worldId: 'world:test-world',
      source: 'speculus',
      sanitized: true,
    });
    const raw = JSON.stringify(observed[0].body);
    expect(raw).toContain('I walk into the workshop.');
    expect(raw).toContain('The workshop door opens');
    expect(raw).not.toContain('generationGrant');
    expect(raw).not.toContain('prompt');
    expect(raw).not.toContain('test-only-opaque-generation-grant');
  });

  it('retracts a deleted V2/V3 research turn using the same stable bundle identity', async () => {
    env();

    const deleted: string[] = [];
    const studium = express();
    studium.use(express.json());
    studium.delete('/api/v1/bundles/:bundleId', (req, res) => {
      deleted.push(req.params.bundleId);
      res.json({ ok: true, removed: true });
    });
    vi.stubEnv('STUDIUM_API_URL', await listen(studium));
    vi.stubEnv('STUDIUM_BRIDGE_SECRET', 'test-studium-bridge-secret');

    const base = await listen(createApp());
    const launchId = 'studium-retract-launch';
    const packageValue = v2Package({
      launchId,
      relatedAssets: [
        { id: 'world:test-world', type: 'world', revision: 'world-rev-1', name: 'Test World', summary: 'Fixture world.', data: {} },
      ],
    });
    const deposited = await post(base, '/api/v2/launch', packageValue, auth);
    const launchUrl = (await deposited.json() as { launchUrl: string }).launchUrl;
    const code = new URL(launchUrl).searchParams.get('launch');
    const claimed = await fetch(`${base}/api/v2/launch/${code}`);
    const cookie = claimed.headers.get('set-cookie')!.split(';')[0];

    const response = await post(base, '/api/v2/research/retract', {
      launchId,
      sessionId: 'session-fixture',
      turnId: 'turn:7',
    }, { Cookie: cookie });

    expect(response.status).toBe(202);
    expect(deleted).toEqual(['speculus:session-fixture:turn:7']);
  });

  it('preserves V3 identity in Studium research records', async () => {
    env();

    const observed: Array<Record<string, unknown>> = [];
    const studium = express();
    studium.use(express.json());
    studium.post('/api/v1/bundles', (req, res) => {
      observed.push(req.body);
      res.status(201).json({ ok: true, inserted: true });
    });
    vi.stubEnv('STUDIUM_API_URL', await listen(studium));
    vi.stubEnv('STUDIUM_BRIDGE_SECRET', 'test-studium-bridge-secret');

    const base = await listen(createApp());
    const launchId = 'studium-v3-launch';
    const packageValue = v2Package({
      launchId,
      relatedAssets: [
        { id: 'world:test-world', type: 'world', revision: 'world-rev-1', name: 'Test World', summary: 'Fixture world.', data: {} },
      ],
    });
    const deposited = await post(base, '/api/v2/launch', packageValue, auth);
    const launchUrl = (await deposited.json() as { launchUrl: string }).launchUrl;
    const code = new URL(launchUrl).searchParams.get('launch');
    const claimed = await fetch(`${base}/api/v2/launch/${code}`);
    const cookie = claimed.headers.get('set-cookie')!.split(';')[0];

    const response = await post(base, '/api/v2/research', {
      launchId,
      sessionId: 'session-v3',
      turnId: 'turn:1',
      occurredAt: Date.now(),
      player: 'Look around.',
      reply: 'The room is quiet.',
      worldRevision: 1,
      locationId: null,
      reroll: false,
      engine: 'v3',
    }, { Cookie: cookie });

    expect(response.status).toBe(202);
    const raw = JSON.stringify(observed[0]);
    expect(raw).toContain('"kind":"speculus_v3_turn"');
    expect(raw).toContain('"speculus-v3"');
    expect(raw).not.toContain('"speculus-v2"');
  });

  it.each([1, 2] as const)('shows the underlying Orbis/NovelAI error in V%s without echoing upstream data', async (version) => {
    env(); const gateway = express(); gateway.use(express.json());
    const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let calls = 0;
    gateway.post('/generate', (_req, res) => {
      calls += 1;
      res.status(502).json({
        code: 'NOVELAI_INVALID_REQUEST', upstreamStatus: 400, parameter: 'max_tokens', requestedMaxTokens: 1024,
        requestId, error: 'test-only-opaque-generation-grant PRIVATE PROVIDER TOKEN PRIVATE SCENE',
      });
    });
    vi.stubEnv('ORBIS_GENERATION_API_URL', `${await listen(gateway)}/generate`);
    const base = await listen(createApp());
    const launch = await deposit(base, version);
    const prefix = version === 2 ? '/api/v2' : '/api';
    const claimed = await fetch(`${base}${prefix}/launch/${launch.code}`);
    const cookie = claimed.headers.get('set-cookie')!.split(';')[0];
    const response = await post(base, `${prefix}/generate`, requestBody(`fixture-launch-${version}`), { Cookie: cookie });
    expect(response.status).toBe(502);
    const failure = await response.text();
    expect(failure).toContain('NovelAI HTTP 400');
    expect(failure).toContain('Rejected parameter: max_tokens');
    expect(failure).toContain('Requested output: 1024 tokens');
    expect(failure).toContain(requestId);
    expect(failure).not.toContain('test-only-opaque-generation-grant');
    expect(failure).not.toContain('PRIVATE');
    expect(calls).toBe(1);
  });

  it.each([
    ['legacy', 'NovelAI returned an empty roleplay reply.'],
    ['html', 'HTTP 502 without a recognized error'],
    ['unknown', 'HTTP 502 without a recognized error'],
  ])('handles a %s Orbis failure during a staged deployment', async (kind, expected) => {
    env(); const gateway = express();
    gateway.post('/generate', (_req, res) => {
      if (kind === 'legacy') res.status(502).json({ error: 'NovelAI returned an empty roleplay reply.' });
      else if (kind === 'html') res.status(502).send('<html>PRIVATE UPSTREAM ERROR</html>');
      else res.status(502).json({ code: 'toString', error: 'PRIVATE UPSTREAM ERROR', requestId: 'PRIVATE REQUEST ID', parameter: 'PRIVATE' });
    });
    vi.stubEnv('ORBIS_GENERATION_API_URL', `${await listen(gateway)}/generate`);
    const base = await listen(createApp());
    const launch = await deposit(base, 2);
    const claimed = await fetch(`${base}/api/v2/launch/${launch.code}`);
    const response = await post(base, '/api/v2/generate', requestBody('fixture-launch-2'), { Cookie: claimed.headers.get('set-cookie')!.split(';')[0] });
    expect(response.status).toBe(502);
    const failure = await response.text();
    expect(failure).toContain(expected);
    expect(failure).not.toContain('PRIVATE');
  });
});
