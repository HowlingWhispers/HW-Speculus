# Speculus

Speculus is the Orbis-launched character and roleplay simulator for The Howling Whispers. It is hosted as a separate service, but it has no normal standalone loading flow.

The user selects a character, world, place, item, faction, or other record in Orbis and clicks **Simulate**. Orbis boxes the selected record, its connected context, the active persona, relationship state, and a temporary generation grant into a versioned launch package. Speculus claims that package once and boots directly into the simulation.

A direct visit without an active package deliberately produces a 1982-style missing-system-medium error.

## Experimental V2

`/v2` is a separately loaded research terminal and runtime foundation. V1 at `/`
keeps its existing behavior. Select V2 in Orbis Account settings and use Simulate
to receive a V2 launch. State, authorization cookies and raw export formats remain
separate. See [V2 foundation and rollout](docs/v2-foundation.md) for implemented
features, explicit limitations and the matching Orbis migration.

## Security boundary

- NovelAI credentials are entered and managed only in Orbis.
- Speculus never receives the raw NovelAI token.
- Ollama and provider selection are not part of Speculus.
- Orbis sends a short-lived opaque generation grant in the server-to-server launch package.
- Speculus seals that grant inside an HTTP-only server session and sends generation requests to the shared Orbis API.
- Browser diagnostics expose safe provider metadata only.

## Raw session export and resume

The terminal provides **EXPORT RAW** and **IMPORT RAW** controls for portable roleplay continuation files.

A raw session export preserves the authored scene, transcript, relationship state, diagnostics, turn counter, timestamps, and user-facing simulator settings. It deliberately does not export the temporary Orbis launch package, launch ID, expiry, generation grant, or provider credentials.

To continue an old session later:

1. Open the same source asset in Orbis and start a fresh Speculus simulation.
2. Choose **IMPORT RAW** in Speculus.
3. Select the previously exported `*-speculus-session.json` file.
4. Speculus verifies that the export belongs to the same Orbis asset, restores the old simulation state, and keeps the fresh Orbis launch authorization and current model route.

Importing a raw session into a different source asset is rejected rather than silently mixing two simulations.

## Start locally

```bash
npm install
npm run dev:api
npm run dev
```

Open `http://localhost:5175`. Without a launch package, the terminal correctly halts with `BOOT FAILURE: SIMULATION PACKAGE NOT FOUND`.

## Orbis launch exchange

Orbis sends a server-to-server `POST /api/launch` with:

```http
Authorization: Bearer <SPECULUS_BRIDGE_SECRET>
Content-Type: application/json
```

The version 1 package contains the primary asset, related records, optional character card, active persona, scene, context blocks, relationship state, selected model, expiry, and an opaque generation grant. The response contains a one-time `launchUrl` that Orbis opens for the user.

The browser claims that package once. Speculus removes the launch code from the address bar, creates an HTTP-only generation session, and stores only the non-secret simulation state in tab-scoped `sessionStorage`.

## Environment

Copy `.env.example` to the protected service environment:

```env
PORT=8790
SPECULUS_PUBLIC_ORIGIN=https://spec.thehowlingwhispers.com
SPECULUS_BRIDGE_SECRET=<shared server-to-server secret>
ORBIS_GENERATION_API_URL=http://127.0.0.1:8789/api/v1/generation/speculus
SPECULUS_UPDATE_DATE=<YYYY-MM-DD deployment date>
STUDIUM_API_URL=http://127.0.0.1:4310
STUDIUM_BRIDGE_SECRET=<shared Studium ingestion secret>
```

`SPECULUS_BRIDGE_SECRET` authorizes Orbis to deposit launch packages. It is not a NovelAI token. `ORBIS_GENERATION_API_URL` must point to the internal shared generation gateway.

When `STUDIUM_API_URL` and `STUDIUM_BRIDGE_SECRET` are configured, committed V2 turns are handed to Studium through the Speculus server. The browser never receives the Studium secret. Research delivery is non-blocking: a Studium outage must not prevent a roleplay turn from committing. The research bundle contains bounded committed player/reply text and small world metadata, but not compiled prompts, diagnostics, provider credentials, generation grants, or hidden Orbis context.

## Commands

```bash
npm test
npm run lint
npm run build
npm run start:api
```

The complete boundary is recorded in [`docs/architecture.md`](docs/architecture.md).
