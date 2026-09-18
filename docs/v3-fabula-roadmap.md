# Speculus V3 contributions toward Fabula

Speculus V3 is the experimental runtime where systems can be developed, tested and proven for possible use in Fabula. It is not a disposable prototype, but it is also not the official Fabula design or a promise that Speculus will simply be renamed. Fabula's architecture, interface, visual design and theme will be designed separately later.

V2 remains the stable fallback while V3 replaces inherited systems in controlled, testable steps.

## Research basis

V3 architecture is informed by the supplied NovelAI userscripts as research specimens, not source code to copy.

The strongest recurring patterns are:

- Character Engine: explicit state, clock, schedules, journals, context injection, dynamic character processing, travel/presence and a rule that generated classifications do not directly write discrete state.
- World Explorer: persistent geography, routes, movement, time, encounters, factions, conquest, NPC/hero movement, spatial lore and world import/export.
- Adventure Engine: typed entities, resources, knowledge, action/effect rules, a single entity-creation path, staged generate/review/commit authoring, context block priorities and generation watchdog/continuity handling.
- Living Chronicle / Chronicle Tracker: short-term state, long-term canon-like summaries, recap/season/archive tiers, delta merges, backfill and reroll-aware delayed commits.
- Relationship Keeper / Persona Keeper: event-rich relationship state, pacing stages and identity-specific relationship contexts.
- Mystery Keeper: objective hidden truth, reveal stages, per-NPC knowledge and controlled injection windows.
- Inventory, equipment, wardrobe, trait, spell and stat helpers: the same lesson repeated in several forms, namely that concrete mechanical state must not depend on prose memory.
- ChatRPG and the Disco-style skill system: deterministic dice/skill mechanics, resources, wounds/strain, encumbrance, survival, economy, durability and explicit check outcomes.

The implementation must be original Howling Whispers code with our own contracts and naming.

## Runtime constitution

V3 should converge on these rules:

1. Orbis canon is read-only during ordinary play.
2. Mutable session state has one authoritative runtime representation.
3. Generated prose is downstream of state and never becomes state merely because the model said it.
4. A model may classify, propose or render. Deterministic code validates and commits discrete changes.
5. Every irreversible runtime change has an owning event/transaction so reroll, delete and undo can reason about it.
6. Hidden information carries an explicit visibility/knowledge boundary.
7. Context is a projection of canon plus runtime state, assembled as whole typed blocks with explicit priorities and budgets.
8. Internal protocol/state markers never enter visible story text.
9. Failures do not create half-committed turns.
10. V3 features that may benefit Fabula should be modular enough to reuse or adapt without forcing the current Speculus product design onto Fabula.

## Target runtime layers

### 1. Core session and transaction layer

Owns session identity, source revisions, world revision, event ledger, turn ownership, reroll semantics and commit/rollback boundaries.

A turn should conceptually move through:

`input -> resolve -> stage state delta -> compile context -> generate -> validate -> commit`

If generation or validation fails, the staged state delta is discarded. A reroll reuses the already-resolved authoritative state for that turn unless the operator explicitly asks to resolve again.

### 2. Authoritative world state

Extend the current V3 world state into explicit domains rather than one ever-growing loose object.

Planned domains:

- clock/calendar
- scene/location/presence
- actors and schedules
- knowledge
- inventories/equipment
- conditions/needs/health
- relationships
- resources/currencies
- mysteries/reveal state
- factions/world events
- chronicle/memory
- encounters and active resolutions

Each domain gets its own schema and state-transition functions.

### 3. World Brain

The World Brain is one effective world-level behavior constitution, supplied by Orbis as a pinned revision.

It governs interpretation, autonomy, prose behavior, context policy and world-specific rules. It does not replace deterministic runtime invariants.

Characters remain data. They do not each receive independent editable brains.

### 4. Context compiler

Replace ad-hoc prompt concatenation with typed context blocks.

Each block should eventually carry:

- stable ID
- title/purpose
- source/revision
- audience/visibility
- priority
- required/optional status
- estimated size
- rendered content

Required blocks fail closed if they cannot fit. Optional blocks are included whole according to priority and relevance. Do not silently truncate a character sheet or mystery in the middle of a field.

The renderer, resolver and background/autonomy passes may receive different projections from the same state.

### 5. Character autonomy and schedules

Characters need persistent runtime state without becoming independent rule engines.

Runtime character processing should use:

- authored persona/traits/goals from Orbis
- current location/presence
- schedule/home data
- needs/conditions
- relationships
- knowledge
- inventory/equipment
- recent personal chronicle
- World Brain rules

Only characters relevant to the current simulation window should consume expensive model work. Off-screen simulation should be budgeted and cadence-driven rather than invoking every NPC every turn.

### 6. Knowledge, secrets and mysteries

Objective truth, what each actor knows, and what the player can perceive are separate.

A hidden fact can exist in runtime state without entering player-visible context. Mystery progression should be a state machine or authored reveal plan, not a request to the renderer to "please keep this secret."

### 7. Inventory, equipment and physical resources

Runtime inventory must reference canonical Orbis item IDs where possible.

Track at least:

- owner/container
- quantity
- equipped/carried/stored state
- durability/condition where relevant
- mass/encumbrance contribution
- transaction/event ownership

Model prose may describe an item transfer only after the state transition is authorized or resolved.

### 8. Relationships and chronicles

Relationship state should preserve events and semantic factors, not only one floating score.

Chronicle memory should be tiered:

- immediate scene/short-term state
- durable session chronicle
- compact recaps
- archive

Compression must preserve source facts and must never silently rewrite Orbis canon.

### 9. Mechanics and action resolution

V3 already has a Genesys-style resolution foundation. Grow it into a general action system with world-authored definitions.

Future Fabula-capable mechanics can include:

- skills/attributes
- advantage/threat and triumph/despair
- resources and temporary modifiers
- wounds/strain/conditions
- encumbrance
- survival needs
- economy/currency
- durability
- encounters
- jobs and other world-specific systems

The World Brain can guide which mechanic applies, but the actual roll and state mutation belong to code.

### 10. World simulation

After the state kernel is stable, add:

- route graph and travel costs
- random/conditional encounters
- NPC movement
- faction activity
- ambient events
- settlement/world schedules
- off-screen consequence processing

Procedural world creation is an authoring concern unless a world explicitly supports runtime procedural expansion. Runtime procedural creation must stage new canonical-looking entities separately from actual Orbis canon.

## Orbis contract

V3 should expect Orbis to become progressively richer without importing Orbis code.

Launch packages should eventually carry a versioned projection containing:

- canonical source IDs and revisions
- effective World Brain revision
- world graph subset
- character/persona definitions
- rules/mechanical definitions
- initial runtime seed state
- visibility and knowledge metadata

Provider credentials remain outside V3.

## Phased delivery

### Phase A: state and context foundation

- add typed context-block selector and diagnostics
- define V3 state-domain contracts
- define transaction/state-delta shape
- keep current V2-compatible launch contract
- no user-visible gameplay expansion yet

### Phase B: World Brain contract

- receive a pinned brain revision from Orbis
- standard brain fallback
- brain diagnostics/version display
- context compiler applies brain source without exposing it to story text

### Phase C: continuity systems

- actor knowledge
- relationship events/state
- chronicle tiers
- mystery/reveal state
- schedule hooks
- reroll/undo ownership for all new state

### Phase D: physical mechanics

- canonical item references
- inventory/equipment
- resources/conditions
- generalized checks and modifiers
- encumbrance/durability as world-enabled mechanics

### Phase E: living world

- route/travel engine
- encounters
- NPC movement and off-screen cadence
- factions/world events
- optional map/spatial state

### Phase F: Fabula handoff readiness

This phase does not rename Speculus into Fabula. It identifies which V3 systems have become stable enough to serve as inputs to the later official Fabula design.

A system is a strong Fabula candidate when:

- its launch/save contracts are versioned and migration-tested
- World Brain editing/pinning works through Orbis
- no state domain relies on prose memory as authority
- reroll/undo/delete do not double-apply state
- long-running continuity survives save/load
- diagnostics can explain what context and state produced a turn
- gameplay mechanics have clear boundaries and tests
- the implementation is modular enough to reuse without carrying over the Speculus UI/theme

When Fabula design begins, each proven subsystem can be adopted, adapted or replaced. The current Speculus interface and theme are not Fabula design decisions.
