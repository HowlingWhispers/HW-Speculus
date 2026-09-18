# Speculus repository rules

- Work on `main`. Temporary feature branches are non-authoritative until merged into `main`.
- Keep V2 as the stable baseline. V3 is the experimental runtime built directly from V2; replace or remove V2-derived pieces inside V3 as needed without silently changing V2 behavior.
- V3 may temporarily reuse the V2 launch/generation authorization contract while its client runtime is isolated. Keep V2 and V3 browser session/autosave stores separate.
- V3 must never expose internal turn/protocol markers such as `[PLAYER TURN]`, `[END PLAYER TURN]`, `[IN-WORLD RESPONSE]`, or similar transport scaffolding in player-visible transcript text.
- Keep Speculus standalone. Never add runtime imports from HW-Orbis, HW-Library, or the historical HowlingWhispers application.
- Keep React UI, simulator orchestration, pure runtime logic, storage, and provider transports separated.
- Normal production sessions arrive through a one-time Orbis launch package. The standalone root may inspect and stage a raw V2 save for recovery, but it must never generate until a matching fresh Orbis launch authorization has been issued.
- Raw save files must remain authorization-free: never export launch IDs, grants, expiry tokens, cookies, or provider credentials. Canon/source identity and revisions are safe to export for compatibility checks.
- Provider adapters receive compiled prompts, never mutable session state.
- NovelAI credentials belong to the user's Orbis settings. Never request, receive, display, log, or persist the raw provider token in Speculus.
- Do not add Ollama or provider selection controls. Generation goes through the Orbis shared API.
- Stable character turn IDs own relationship and automatic turn-resolution events. Rerolls reuse/replace the same resolved turn state rather than advancing state again; deletion removes that turn's owned resolution state when safe.
- Preserve RP formatting: dialogue in double quotes, action/narration in single asterisks, inner voice in square brackets.
- Respect reduced motion and keep CRT effects readable.
- V3 is the incubation path for the runtime that will eventually be promoted/renamed to Fabula; do not build a separate parallel Fabula runtime. Until that promotion, keep accounts, Discord, multiplayer and World Forge out of this repository. The narrow Orbis launch/generation bridge plus raw-save recovery handoff are the only allowed integrations.
- Before completion run `npm test`, `npm run lint`, and `npm run build`.
