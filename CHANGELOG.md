# Speculus Changelog

Speculus uses a human-readable release version plus a 7-character Git build id shown in the terminal, for example `v0.2.0+5890c7b`.

## Unreleased: isolated V2 foundation

- Make V3 the normal root runtime; keep V1 at `/v1` and V2 at `/v2` as frozen legacy versions.
- Stop treating V2 and V3 as paired development targets. New work is V3-only unless a legacy fix is explicitly requested.

- Remove the V1/V2/V3 engine switcher from V3 Setup; V3 is already its own runtime and keeps its Experimental identity in the masthead instead.

- Restyle the V3 terminal, controls, diagnostics and detached reader with the darker slate/cyan Comms palette while preserving the terminal-first layout and roleplay text colors.

- Add review-only V3 state reconciliation for conservative canonical inventory suggestions derived from committed replies.
- Add explicit Accept/Reject controls; generated prose still cannot directly mutate authoritative inventory.
- Persist pending state proposals in raw saves and expose them in Diagnostics.
- Tag accepted reconciliation actions to their source turn so reroll/delete can roll them back before replacing or removing that turn.

- Add canonical operator-controlled V3 inventory using only Orbis-packaged item records and packaged actors.
- Add V3 inventory controls for owner, quantity, equipped state and removal; generated prose remains unable to author inventory.
- Persist canonical inventory through the world event ledger and raw save/import validation, and inject relevant inventory into renderer context as read-only engine state.

- Add priority-budgeted V3 context blocks so engine authority, current canon and player input stay protected while optional history/state is admitted by importance.
- Add tiered long-session memory: 4 full recent exchanges, 12 compact chronicle turns and up to 48 lower-priority archive turns derived from the committed ledger.
- Add V3 Memory and Domains diagnostics so context tiers and runtime state can be inspected directly.
- Reuse the existing Speculus relationship ledger in V3, including valid Orbis starting state, explicit bounded relationship cues, raw-save persistence, reroll replacement and delete rollback.
- Keep unrevealed mystery state out of player-visible V3 context; only player-known/revealed mystery state may be injected.

- Send committed V3 turns to Studium with explicit V3 research identity instead of leaving World Brain experiments invisible to research.
- Retract a turn's Studium research bundle when the latest committed turn is deleted; rerolls continue replacing the same stable research identity.
- Make V2 and V3 terminal-first by default with Setup and Diagnostics closed until requested.
- Group low-frequency turn/session operations into compact menus so the transcript and composer remain the dominant workspace.
- Change the V2/V3 composer to Enter-to-send and Shift+Enter for a newline.

- Begin the V3 experimental runtime as an isolated copy of the working V2 client baseline while V2 remains the stable fallback.
- Add a dedicated `/v3` entry route. V3 is intentionally built on V2 first, then V2-derived systems can be removed or replaced inside V3 without destabilizing V2.
- Document V3 protocol isolation as a hard requirement: internal turn-boundary markers must never reach player-visible chat.

- Harden canonical travel resolution by merging compact place navigation with matching Orbis context data and honoring imported place source IDs.
- Add a regression for completed first-person travel to Brackenjaw Ranger Station so location and elapsed travel time must commit before rendering.
- Preserve safe Orbis/NovelAI error categories, provider status, rejected setting
  and request IDs instead of hiding generation failures behind a generic 502.
  Handle unreadable V2 gateway responses without a JSON parsing crash.
- Add a separately loaded `/v2` research terminal, runtime, context compiler,
  explicit world/knowledge state, event ledger and versioned raw session transfer.
- Add version-2 launch/claim/generation endpoints and independent per-launch
  HTTP-only cookies. V1 code and behavior remain in the V1 entry.
- Wire existing NovelAI bridge controls into V2 with output-only length presets.
- Document incomplete semantic validation, memory, physics and rollout requirements
  in `docs/v2-foundation.md`.

## [0.4.1] - 2026-09-10

### Fixed
- The resizable Debug inspector is docked beside the terminal again. Dragging the divider now resizes both panels together instead of allowing the inspector to cover terminal content.
- The same docked behavior works whether the Package panel is visible or collapsed.

## [0.4.0] - 2026-09-10

### Added
- Display menu with Blue Moon, Green Phosphor, Amber, Violet, and Monochrome palettes.
- Independent Night, Day, and System brightness selection for every palette.
- Persistent per-browser phosphor color preference.

### Changed
- Debug now opens as a resizable overlay inspector and no longer compresses the transcript or composer.
- Replaced the horizontally scrolling diagnostic navigation with a compact 3-by-3 view grid.
- Shortened the visible Relationship diagnostic label to Relations while preserving its underlying data view.
- Moved display theme and CRT motion controls out of the package rail into the dedicated Display menu.

## [0.3.0] - 2026-09-10

### Added
- Terminal-first workstation mode with independently collapsible Package and Debug panels.
- Compact header view controls and an explicit Debug mode indicator.
- Progressive-disclosure sections for the package manifest and control deck.

### Changed
- The terminal now owns the available workspace whenever either side panel is closed.
- Debug tools are hidden by default for new sessions and remain available in a dedicated inspector.
- Package essentials remain visible while low-frequency metadata and display/model controls stay collapsed until needed.
- Reduced panel widths, header height, control padding, transcript spacing, diagnostic density, and composer-tool footprint.
- Diagnostics tabs now use a compact scrollable instrument strip instead of oversized wrapped button tiles.
- Reorganized raw transfer, buffer copy, and exit controls into a compact inspector action bank.

## [0.2.0] - 2026-09-10

### Added
- Project changelog and visible build/version identity in the terminal footer.
- Smart roleplay composer helpers for action, dialogue, and thought formatting.
- AI-assisted `FORMAT MY TEXT`, constrained to repair formatting without rewriting the draft.
- Per-session draft autosave and automatic recovery after refresh/navigation.
- Local `SAVE CHECKPOINT` / `RESTORE LAST` simulator checkpoints.
- Response calibration control: Concise, Normal, Long, and Adaptive.
- Per-turn context/token meter in the composer and Diagnostics panel.
- Knowledge-boundary diagnostics showing observed/available versus filtered information.
- Reroll comparison diagnostics retaining the replaced answer for inspection while keeping the reroll canonical.
- Regression coverage for non-character entity routing and response calibration.

### Changed
- Tab escape now jumps past the closing smart-pair marker and inserts one separator space when whitespace is not already present.
- Pasted curly double quotes are normalized to straight roleplay dialogue quotes.
- Provider failures are classified as authorization, timeout, context-size, rate-limit, network/bridge, empty-generation, or invalid-response faults instead of collapsing into one generic error.
- Non-character Orbis assets are routed through a neutral simulation narrator rather than being converted into characters. The compiled context explicitly preserves the primary entity type and forbids personifying places, items, factions, worlds, and other non-character records.
- Unknown information is explicitly required to remain unknown in compiled model context.
- Response calibration now affects both generation instructions and output token limits.

### Existing in this release line
- Diagnostics side-panel visibility control and resizable workstation panels.
- Exact compiled-context inspector with manifest data.
- Raw session import/export support.
