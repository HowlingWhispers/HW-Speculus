# Speculus repository rules

- Work on `main`. Temporary feature branches are non-authoritative until merged into `main`.
- V4 is the current/main Speculus runtime and active development target. V1, V2 and V3 are frozen historical runtimes. Do not mirror V4 features, UI changes, refactors, or fixes into V1/V2/V3 unless the user explicitly asks for a legacy change.
- Keep V4 launch/generation authorization isolated from legacy runtimes. Save compatibility is not permission to synchronize development with frozen runtimes. Keep V4 and legacy browser session/autosave stores separate.
- V4 must never expose internal turn/protocol markers such as `[PLAYER TURN]`, `[END PLAYER TURN]`, `[IN-WORLD RESPONSE]`, or similar transport scaffolding in player-visible transcript text.
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
- V4 and later Speculus versions are development grounds for systems that may later contribute to Fabula. Do not assume V4 will be renamed into Fabula or that current Speculus UI/theme is Fabula design. Fabula gets its own design phase later. Keep reusable runtime systems modular and portable. Accounts, Discord, multiplayer and World Forge remain outside this repository; the narrow Orbis launch/generation bridge plus raw-save recovery handoff are the only allowed integrations.
- Before completion run `npm test`, `npm run lint`, and `npm run build`.
