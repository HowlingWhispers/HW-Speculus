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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const origin = 'https://spec.thehowlingwhispers.com';
const auth = { Authorization: 'Bearer test-v4-bridge-secret' };
function env() {
  vi.stubEnv('SPECULUS_BRIDGE_SECRET', 'test-v4-bridge-secret');
  vi.stubEnv('SPECULUS_PUBLIC_ORIGIN', origin);
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const generation = (launchId: string) => ({
  launchId, provider: 'orbis', prompt: 'Render.', model: 'xialong-v1', temperature: 0.7, maxTokens: 1024,
  topK: 30, topP: 0.8, presencePenalty: 0.1, frequencyPenalty: 0.2, stopSequences: ['STOP'], continueToEndOfSentence: false,
});
const research = (launchId: string) => ({
  launchId, sessionId: 'session-v4', turnId: 'turn:7', occurredAt: Date.now(), player: 'Look around.',
  reply: 'The room is quiet.', worldRevision: 1, locationId: null, engine: 'v4',
});
const resume = (version: 2 | 4 = 4) => ({
  format: `speculus-v${version}-session`, version, engine: `v${version}`,
  source: { id: v2Package().primaryAsset.id, type: v2Package().primaryAsset.type, revision: v2Package().primaryAsset.revision },
  turns: [{ player: 'Look around.', reply: 'Quiet.' }],
});
async function deposit(base: string, body: unknown = v2Package(), route = '/api/v4') {
  const response = await post(base, `${route}/launch`, body, auth);
  expect(response.status).toBe(201);
  const { launchUrl } = await response.json() as { launchUrl: string };
  return { code: new URL(launchUrl).searchParams.get('launch'), launchUrl };
}
async function claim(base: string, code: string | null, route = '/api/v4') {
  const response = await fetch(`${base}${route}/launch/${code}`);
  expect(response.status).toBe(200);
  return { response, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}

describe('isolated V4 bridge', () => {
  it('requires authorization and preserves the version-2 wire contract', async () => {
    env(); const base = await listen(createApp());
    expect((await post(base, '/api/v4/launch', v2Package())).status).toBe(401);
    expect((await post(base, '/api/v4/launch', v2Package(), { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(base, '/api/v4/launch', { ...v2Package(), version: 4, engine: 'v4' }, auth)).status).toBe(400);
    expect((await post(base, '/api/v4/launch', { ...v2Package(), expiresAt: 1 }, auth)).status).toBe(400);
    const deposited = await deposit(base);
    expect(new URL(deposited.launchUrl).pathname).toBe('/v4');
    const { response } = await claim(base, deposited.code);
    expect(await response.json()).toMatchObject({ package: { version: 2, engine: 'v2' } });
    expect((await fetch(`${base}/api/v4/launch/${deposited.code}`)).status).toBe(404);
  });

  it.each([2, 4] as const)('accepts authorization-free version %s resumes only in V4', async (version) => {
    env(); const base = await listen(createApp());
    const save = resume(version);
    const deposited = await deposit(base, { package: v2Package(), resumeSave: save });
    const { response } = await claim(base, deposited.code);
    const result = await response.json();
    expect(result.resumeSave).toEqual(save);
    expect(JSON.stringify(result)).not.toContain('test-only-opaque-generation-grant');
    if (version === 4) expect((await post(base, '/api/v2/launch', { package: v2Package(), resumeSave: save }, auth)).status).toBe(400);
  });

  it.each(['id', 'type', 'revision'] as const)('rejects resume source %s mismatches', async (field) => {
    env(); const base = await listen(createApp()); const save = resume();
    if (field === 'type') save.source.type = save.source.type === 'world' ? 'character' : 'world';
    else save.source[field] = 'mismatched';
    expect((await post(base, '/api/v4/launch', { package: v2Package(), resumeSave: save }, auth)).status).toBe(400);
  });

  it('retains canonical character and packaged-location launch validation', async () => {
    env(); const base = await listen(createApp()); const packageValue = v2Package();
    expect((await post(base, '/api/v4/launch', { ...packageValue, initialLocationId: 'place:not-packaged' }, auth)).status).toBe(400);
    expect((await post(base, '/api/v4/launch', {
      ...packageValue, primaryAsset: { ...packageValue.primaryAsset, type: 'character', id: 'character:mismatch' },
    }, auth)).status).toBe(400);
  });

  it.each(['launchId', 'generationGrant', 'expiresAt', 'authorization', 'cookies', 'providerCredentials', 'api_key', 'accessToken'])('rejects nested authorization field %s', async (field) => {
    env(); const base = await listen(createApp());
    const save = { ...resume(), metadata: { pages: [{ extra: { [field]: 'private' } }] } };
    const response = await post(base, '/api/v4/launch', { package: v2Package(), resumeSave: save }, auth);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private');
  });

  it('isolates deposits, cookie names and encryption keys while reusing the shared provider', async () => {
    env(); const gateway = express(); gateway.use(express.json());
    const observed: Array<Record<string, unknown>> = [];
    gateway.post('/generate', (req, res) => { observed.push(req.body); res.json({ text: 'Hello.', finishReason: 'stop' }); });
    vi.stubEnv('ORBIS_GENERATION_API_URL', `${await listen(gateway)}/generate`);
    const base = await listen(createApp());
    const packageValue = v2Package({ launchId: 'shared-launch-identity' });
    const v2 = await deposit(base, packageValue, '/api/v2'); const v4 = await deposit(base, packageValue);
    expect((await fetch(`${base}/api/v2/launch/${v4.code}`)).status).toBe(404);
    expect((await fetch(`${base}/api/v4/launch/${v2.code}`)).status).toBe(404);
    const old = await claim(base, v2.code, '/api/v2'); const current = await claim(base, v4.code);
    expect(current.cookie).toMatch(/^speculus_v4_/);
    expect(current.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Path=/api/v4');
    expect(current.response.headers.get('cache-control')).toBe('no-store');
    for (const [route, cookie] of [['/api/v4', old.cookie], ['/api/v2', current.cookie], ['/api/v4', old.cookie.replace('speculus_v2_', 'speculus_v4_')]]) {
      expect((await post(base, `${route}/generate`, generation(packageValue.launchId), { Cookie: cookie })).status).toBe(401);
    }
    expect((await post(base, '/api/v4/generate', generation('different-launch'), { Cookie: current.cookie })).status).toBe(401);
    expect((await post(base, '/api/v4/generate', { ...generation(packageValue.launchId), model: 'wrong-model' }, { Cookie: current.cookie })).status).toBe(403);
    for (const [route, cookie] of [['/api/v2', old.cookie], ['/api/v4', current.cookie]]) {
      expect((await post(base, `${route}/generate`, generation(packageValue.launchId), { Cookie: cookie })).status).toBe(200);
    }
    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({ launchId: packageValue.launchId, source: { id: packageValue.primaryAsset.id, type: packageValue.primaryAsset.type, revision: packageValue.primaryAsset.revision }, maxTokens: 1024, topK: 30, topP: 0.8, stopSequences: ['STOP'] });
  });

  it('enforces production origin for generation, submission and retraction', async () => {
    env(); const base = await listen(createApp({ production: true }));
    const launch = await deposit(base); const { cookie, response } = await claim(base, launch.code);
    expect(response.headers.get('set-cookie')).toContain('; Secure');
    for (const [path, body] of [['/generate', generation(v2Package().launchId)], ['/research', research(v2Package().launchId)], ['/research/retract', research(v2Package().launchId)]] as const) {
      const invalidOrigins: Record<string, string>[] = [{ Cookie: cookie }, { Cookie: cookie, Origin: 'https://evil.example' }];
      for (const headers of invalidOrigins) {
        expect((await post(base, `/api/v4${path}`, body, headers)).status).toBe(403);
      }
      expect((await post(base, `/api/v4${path}`, body, { Origin: origin })).status).toBe(401);
    }
    expect((await post(base, '/api/v4/research', research(v2Package().launchId), { Cookie: cookie, Origin: origin })).status).toBe(202);
  });

  it('expires unclaimed deposits and already-issued authorizations', async () => {
    env(); const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const base = await listen(createApp());
    const packageValue = v2Package({ expiresAt: now + 60_000 });
    const pending = await deposit(base, packageValue); const issued = await deposit(base, packageValue);
    const { cookie } = await claim(base, issued.code);
    clock.mockReturnValue(now + 60_001);
    expect((await fetch(`${base}/api/v4/launch/${pending.code}`)).status).toBe(404);
    expect((await post(base, '/api/v4/generate', generation(packageValue.launchId), { Cookie: cookie })).status).toBe(401);
    expect((await post(base, '/api/v4/research', research(packageValue.launchId), { Cookie: cookie })).status).toBe(401);
    expect((await post(base, '/api/v4/research/retract', research(packageValue.launchId), { Cookie: cookie })).status).toBe(401);
  });

  it('submits engine-v4 research and retracts the exact session/turn bundle', async () => {
    env(); const studium = express(); studium.use(express.json());
    const observed: Array<Record<string, unknown>> = []; const deleted: string[] = [];
    studium.post('/api/v1/bundles', (req, res) => {
      expect(req.get('authorization')).toBe('Bearer studium-test'); observed.push(req.body); res.status(201).json({ ok: true });
    });
    studium.delete('/api/v1/bundles/:id', (req, res) => { deleted.push(req.params.id); res.json({ ok: true }); });
    vi.stubEnv('STUDIUM_API_URL', await listen(studium)); vi.stubEnv('STUDIUM_BRIDGE_SECRET', 'studium-test');
    const base = await listen(createApp());
    const packageValue = v2Package({ relatedAssets: [{ id: 'world:test', type: 'world', revision: 'rev-world', name: 'World', summary: 'Fixture.', data: {} }] });
    const launch = await deposit(base, packageValue); const { cookie } = await claim(base, launch.code);
    const body = research(packageValue.launchId);
    expect((await post(base, '/api/v4/research', body, { Cookie: cookie })).status).toBe(202);
    expect((await post(base, '/api/v4/research', { ...body, engine: 'v3' }, { Cookie: cookie })).status).toBe(400);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ bundleId: 'speculus:session-v4:turn:7', worldId: 'world:test', records: [{ recordId: 'speculus:v4:session-v4:turn:7', kind: 'speculus_v4_turn', tags: ['speculus-v4', `source:${packageValue.primaryAsset.type}`, 'committed-turn'] }] });
    expect(JSON.stringify(observed)).not.toContain('generationGrant');
    expect(JSON.stringify(observed)).not.toContain(packageValue.launchId);
    expect((await post(base, '/api/v4/research/retract', body, { Cookie: cookie })).status).toBe(202);
    expect(deleted).toEqual(['speculus:session-v4:turn:7']);
  });
});
