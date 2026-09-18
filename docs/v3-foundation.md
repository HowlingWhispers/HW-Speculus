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


## Fabula promotion path

V3 is not a throwaway experiment. It is the runtime incubation path intended to become Fabula once the state kernel, World Brain contract, continuity systems and gameplay mechanics are mature. New V3 architecture should therefore be product-name-neutral where practical and should not create a second future Fabula implementation beside it.

See `v3-fabula-roadmap.md` for the phased architecture and promotion criteria.
