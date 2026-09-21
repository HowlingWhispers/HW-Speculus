# Speculus V3 experimental foundation

V3 begins as the working V2 runtime, copied into an isolated client runtime so new architecture can be removed, replaced, or added without destabilizing V2.

## Bootstrap rules

- V2 remains the stable fallback.
- V3 is built directly from the V2 client baseline rather than rewritten from nothing.
- V3-specific systems may remove or replace inherited V2 systems as the experiment develops.
- V3 may temporarily reuse the V2 launch and generation authorization contract while its client runtime is isolated.
- V2 and V3 browser session/autosave data must not overwrite each other.

## Protocol isolation

V3 must not expose internal prompt scaffolding in the visible roleplay transcript. Legacy markers such as `[PLAYER TURN]`, `[END PLAYER TURN]`, `[IN-WORLD RESPONSE]`, and similar transport boundaries are runtime concerns, not story text.

## Next architectural layer

The first major V3-only subsystem after the bootstrap is the editable World Brain. It should define world-wide simulation and narrative behavior while character/persona records remain data interpreted through that world brain. A maintained standard brain will be the fallback for worlds that do not provide a custom brain.

V3-only settings belong in the V3 settings experience. V2 settings and stored values must remain intact so the user can always return to the stable engine.


## Contribution toward Fabula

V3 is not throwaway work. Its state kernel, World Brain contract, continuity systems and gameplay mechanics can contribute proven technology and design lessons to Fabula later. V3 itself is not yet the official Fabula implementation, interface, visual design or theme, and no automatic rename/promotion is assumed.

Keep reusable systems modular and product-name-neutral where practical so the later Fabula design can adopt, adapt or replace them deliberately.

See `v3-fabula-roadmap.md` for the current Speculus development path and the systems intended to inform Fabula.


## Continuity and memory

V3 now budgets context through explicit priority blocks instead of appending optional context until the prompt is full.

Committed turn history is exposed in three deterministic tiers:

- the latest 4 turns remain full recent exchanges
- the preceding 12 turns become compact chronicle entries
- up to 48 older turns become a lower-priority archive recap

These memory tiers are derived from the committed turn ledger rather than stored as a second authoritative state. Reroll and delete therefore change derived memory automatically. Current engine state and current Orbis canon always outrank chronicle/archive text.

## Relationship continuity

V3 reuses Speculus's existing relationship ledger for character-primary simulations. Orbis launch relationship state is accepted when valid, explicit relationship-changing player cues can update bounded relationship dimensions, and the current relationship is included as behavior context rather than player-visible knowledge.

Relationship events use stable V3 turn IDs. Rerolls replace the same turn's relationship event and deleting the latest turn removes its relationship event. Neutral turns do not create zero-change events.

The future V3 world-domain relationship model remains separate from this session relationship ledger so experiments can evolve without pretending the two models are already the same system.

## Hidden-state boundary

V3 runtime mystery state is not automatically exposed to the renderer. Only player-known/revealed mystery state may enter player-visible context, and injected mystery state is explicitly forbidden from expanding beyond revealed facts.


## Canonical inventory

V3 has an authoritative inventory domain for item instances. Inventory is changed only through explicit trusted world actions.

Rules:

- every inventory instance must reference an item record already packaged by Orbis
- owners must be packaged actors or null/unowned
- generated roleplay prose cannot create, remove, equip or transfer inventory
- inventory actions increment world revision and are captured in the operator ledger
- raw session export/import preserves inventory state and validates item/actor references
- the renderer receives relevant inventory as read-only engine state
- rerolls do not repeat inventory operations because they reuse already-resolved world state

The current V3 Setup panel exposes manual add/equip/remove controls as an operator tool. Natural-language inventory resolution remains deferred until a deterministic resolver can prove the intended canonical item and operation.
