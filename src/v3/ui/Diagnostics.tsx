import { useMemo, useState } from 'react';
import { V3_ARCHIVE_TURN_COUNT, V3_CHRONICLE_TURN_COUNT, V3_RECENT_EXCHANGE_COUNT } from '../runtime/context';
import type { V3Diagnostics, V3Session } from '../runtime/session';
import { assetsFor, perceptionFor, worldClock } from '../runtime/world';

const tabs = ['state', 'memory', 'domains', 'review', 'context', 'knowledge', 'perception', 'cast', 'provider', 'turns', 'events', 'raw'] as const;
type Tab = (typeof tabs)[number];

function printableTurns(session: V3Session) {
  return session.turns.map((turn, index) => [
    `TURN ${String(index + 1).padStart(3, '0')} / ${turn.id}`,
    `PLAYER · ${session.launch.persona.name}\n${turn.player}`,
    `${(session.launch.character?.name ?? 'SIMULATION NARRATOR').toUpperCase()}\n${turn.reply}`,
  ].join('\n\n')).join('\n\n========================================\n\n');
}

function providerView(session: V3Session, diagnostic: V3Diagnostics | undefined) {
  if (!diagnostic) return { status: 'No generated turn has produced provider diagnostics yet.' };
  const settings = diagnostic.generationSettings ?? {
    output: session.settings.output,
    maxTokens: session.settings.maxTokens,
    temperature: session.settings.temperature,
    topK: session.settings.topK,
    topP: session.settings.topP,
    presencePenalty: session.settings.presencePenalty,
    frequencyPenalty: session.settings.frequencyPenalty,
    stopSequences: session.settings.stopSequences,
    continueToEndOfSentence: session.settings.continueToEndOfSentence,
  };
  return {
    provider: diagnostic.providerKind ?? 'unknown',
    model: diagnostic.model,
    endpoint: diagnostic.providerEndpoint ?? 'not recorded',
    requestId: diagnostic.requestId ?? 'not recorded',
    finishReason: diagnostic.finishReason ?? 'not reported',
    completionStatus: diagnostic.completionStatus,
    durationMs: diagnostic.durationMs,
    requestedMaxTokens: diagnostic.requestedMaxTokens ?? diagnostic.outputBudget,
    providerInputTokensEstimate: diagnostic.providerInputTokensEstimate ?? diagnostic.estimatedInputTokens,
    settings,
  };
}

export function V3DiagnosticsPanel({ session, rejected }: { session: V3Session; rejected: V3Diagnostics | null }) {
  const [tab, setTab] = useState<Tab>('state');
  const [selectedTurnId, setSelectedTurnId] = useState('');
  const selectedTurn = selectedTurnId ? session.turns.find((turn) => turn.id === selectedTurnId) : session.turns.at(-1);
  const diagnostic = selectedTurnId ? selectedTurn?.diagnostics : rejected ?? selectedTurn?.diagnostics;
  const view = perceptionFor(session.world, session.launch.character?.id ?? session.launch.persona.id);
  const clock = worldClock(session.world);
  const location = assetsFor(session.launch).find((asset) => asset.id === session.world.locationId)?.name;
  const presentIds = new Set(view.presentActors.map((actor) => actor.id));
  const cast = session.world.actors.map((actor) => ({
    id: actor.id, name: actor.name, role: actor.role, locationId: actor.locationId,
    presentHere: presentIds.has(actor.id), knownFacts: actor.knowledge.length,
  }));
  const rawView = useMemo(() => ({
    runtime: 'v3-experimental', compatibilitySchema: { version: session.version, engine: session.engine }, source: session.launch.primaryAsset,
    world: session.world, settings: session.settings, turns: session.turns, events: session.events, nextTurn: session.nextTurn,
    sessionRelationships: session.relationships, stateProposals: session.stateProposals,
  }), [session]);
  const contextView = diagnostic ? {
    estimatedInputTokens: diagnostic.estimatedInputTokens,
    outputBudget: diagnostic.outputBudget,
    included: diagnostic.included,
    omitted: diagnostic.omitted,
    warnings: diagnostic.warnings,
    issues: diagnostic.issues,
    prompt: diagnostic.prompt,
  } : { status: 'The first generation will record its exact prompt and settings here.' };
  const knowledgeView = { actor: session.launch.character?.name ?? session.launch.persona.name, knownFacts: view.knownFacts, limitations: view.limitations };
  const perceptionView = { locationId: view.locationId, location, presentActors: view.presentActors, knownFacts: view.knownFacts, limitations: view.limitations };
  const provider = providerView(session, diagnostic);
  const archiveCandidates = Math.max(0, session.turns.length - V3_RECENT_EXCHANGE_COUNT - V3_CHRONICLE_TURN_COUNT);
  const memoryView = {
    committedTurns: session.turns.length,
    recentFullTurns: Math.min(session.turns.length, V3_RECENT_EXCHANGE_COUNT),
    chronicleTurns: Math.min(Math.max(0, session.turns.length - V3_RECENT_EXCHANGE_COUNT), V3_CHRONICLE_TURN_COUNT),
    archiveTurns: Math.min(archiveCandidates, V3_ARCHIVE_TURN_COUNT),
    beyondArchiveWindow: Math.max(0, archiveCandidates - V3_ARCHIVE_TURN_COUNT),
    policy: 'Committed-turn derived memory only. Reroll/delete automatically changes the derived memory because there is no independent memory write.',
  };
  const domainsView = {
    sessionRelationships: session.relationships,
    inventory: session.world.domains.inventory,
    relationships: session.world.domains.relationships,
    resources: session.world.domains.resources,
    conditions: session.world.domains.conditions,
    mysteries: session.world.domains.mysteries,
    chronicleDomain: session.world.domains.chronicle,
  };
  const reviewView = {
    pending: session.stateProposals.length,
    proposals: session.stateProposals,
    policy: 'Review-only. Generated prose cannot directly mutate authoritative state.',
  };
  const content = tab === 'state' ? { world: session.world, clock, location }
    : tab === 'memory' ? memoryView
      : tab === 'domains' ? domainsView
        : tab === 'review' ? reviewView
          : tab === 'context' ? contextView
      : tab === 'knowledge' ? knowledgeView
        : tab === 'perception' ? perceptionView
          : tab === 'cast' ? cast
            : tab === 'provider' ? provider
              : tab === 'events' ? session.events
                : tab === 'raw' ? rawView
                  : printableTurns(session);
  const copyOutput = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

  return <aside className="v2-panel v2-diagnostics" aria-label="Diagnostics"><h2>Diagnostics</h2>
    <label className="v2-field"><span>Diagnostic turn</span><select value={selectedTurnId} onChange={(event) => setSelectedTurnId(event.target.value)}>
      <option value="">{rejected ? 'Latest / rejected draft' : 'Latest turn'}</option>
      {session.turns.map((turn, index) => <option value={turn.id} key={turn.id}>Turn {String(index + 1).padStart(3, '0')} / state r{turn.worldRevision}</option>)}
    </select></label>
    <div className="v2-diagnostic-stats"><span>CTX {diagnostic ? `~${diagnostic.estimatedInputTokens.toLocaleString()}` : '—'}</span><span>OUT {diagnostic?.outputBudget ?? session.settings.maxTokens}</span><span>TURNS {session.turns.length}</span><span>STATE r{session.world.revision}</span></div>
    <div className="v2-tabs" role="tablist" aria-label="Diagnostics view">{tabs.map((name) => <button type="button" role="tab" id={`v2-tab-${name}`} aria-controls="v2-diagnostic-content" aria-selected={tab === name} key={name} onClick={() => setTab(name)}>{name}</button>)}</div>
    <div role="tabpanel" id="v2-diagnostic-content" aria-labelledby={`v2-tab-${tab}`}>
      {tab === 'state' && <>
        <section className="v2-instrument"><h3>World state</h3><dl><dt>Location</dt><dd>{location ?? 'Not anchored'}</dd><dt>World day</dt><dd>Day {clock.simulationDay}</dd><dt>World time</dt><dd>{clock.time}</dd><dt>Day phase</dt><dd>{clock.phase.replaceAll('_', ' ')}</dd><dt>Elapsed world time</dt><dd>{session.world.elapsedSeconds} seconds</dd><dt>State revision</dt><dd>{session.world.revision}</dd><dt>Scene presence</dt><dd>{session.world.locationId ? session.world.actors.filter((actor) => actor.locationId === session.world.locationId).map((actor) => actor.name).join(', ') || 'None' : 'Unknown'}</dd></dl></section>
        <section className="v2-instrument"><h3>Validation</h3><p className={rejected && !selectedTurnId ? 'v2-error-text' : ''}>{rejected && !selectedTurnId ? 'Draft rejected / no commit' : diagnostic ? 'Structural checks passed' : 'Awaiting generation'}</p>{diagnostic?.issues.map((issue) => <p key={issue}>{issue}</p>)}<small>Physical state is protected from prose writes. This is not full semantic canon validation.</small></section>
      </>}
      {tab === 'memory' && <section className="v2-instrument"><h3>Derived session memory</h3><dl><dt>Full recent turns</dt><dd>{memoryView.recentFullTurns}</dd><dt>Chronicle turns</dt><dd>{memoryView.chronicleTurns}</dd><dt>Archive turns</dt><dd>{memoryView.archiveTurns}</dd><dt>Outside archive window</dt><dd>{memoryView.beyondArchiveWindow}</dd></dl><p className="v2-note">{memoryView.policy}</p><small>Chronicle and archive text are context aids only. Current engine state and Orbis canon outrank them.</small></section>}
      {tab === 'domains' && <><section className="v2-instrument"><h3>Runtime domains</h3><dl><dt>Session relationship ledgers</dt><dd>{Object.keys(domainsView.sessionRelationships).length}</dd><dt>Inventory</dt><dd>{domainsView.inventory.length}</dd><dt>World-domain relationships</dt><dd>{domainsView.relationships.length}</dd><dt>Resources</dt><dd>{domainsView.resources.length}</dd><dt>Conditions</dt><dd>{domainsView.conditions.length}</dd><dt>Mysteries</dt><dd>{domainsView.mysteries.length}</dd><dt>Chronicle domain</dt><dd>{domainsView.chronicleDomain.length}</dd></dl></section><details className="v2-instrument"><summary>Domain state</summary><pre>{JSON.stringify(domainsView, null, 2)}</pre></details></>}
      {tab === 'review' && <section className="v2-instrument"><h3>State reconciliation review</h3><dl><dt>Pending proposals</dt><dd>{reviewView.pending}</dd></dl><p className="v2-note">{reviewView.policy}</p><pre>{JSON.stringify(reviewView.proposals, null, 2)}</pre></section>}

      {tab === 'context' && <>
        {diagnostic ? <section className="v2-instrument"><h3>Generation packet</h3><dl><dt>Input tokens</dt><dd>~{diagnostic.estimatedInputTokens.toLocaleString()}</dd><dt>Output allowance</dt><dd>{diagnostic.outputBudget} tokens</dd><dt>Model</dt><dd>{diagnostic.model}</dd><dt>Completion</dt><dd>{diagnostic.completionStatus}</dd><dt>Duration</dt><dd>{(diagnostic.durationMs / 1000).toFixed(1)}s</dd></dl></section> : <p className="v2-note">The first generation will record its exact prompt and settings here.</p>}
        {diagnostic && <><details className="v2-instrument" open><summary>Included</summary><ul>{diagnostic.included.map((value, index) => <li key={index}>{value}</li>)}</ul></details><details className="v2-instrument"><summary>Omitted ({diagnostic.omitted.length})</summary><ul>{diagnostic.omitted.map((value, index) => <li key={index}>{value}</li>)}</ul></details><details className="v2-instrument"><summary>Compiled prompt</summary><pre>{diagnostic.prompt}</pre></details>{diagnostic.warnings.map((warning) => <p className="v2-note" key={warning}>{warning}</p>)}</>}
      </>}
      {tab === 'knowledge' && <section className="v2-instrument"><h3>Known facts</h3><p>{view.knownFacts.length} explicit known facts for {knowledgeView.actor}</p>{view.knownFacts.map((fact, index) => <p key={index}>{fact}</p>)}<small>Unknown facts remain unknown unless authored state or an engine operation makes them known.</small></section>}
      {tab === 'perception' && <section className="v2-instrument"><h3>Current perception</h3><pre>{JSON.stringify(perceptionView, null, 2)}</pre></section>}
      {tab === 'cast' && <section className="v2-instrument"><h3>Engine actors</h3><pre>{JSON.stringify(cast, null, 2)}</pre></section>}
      {tab === 'provider' && <section className="v2-instrument"><h3>Provider</h3><pre>{JSON.stringify(provider, null, 2)}</pre></section>}
      {tab === 'turns' && <section className="v2-instrument"><h3>Transcript buffer</h3><pre>{printableTurns(session) || 'NO TRANSCRIPT DATA'}</pre></section>}
      {tab === 'events' && <><p className="v2-note">Operator changes and accepted replies only. Rerolls replace the same turn event.</p>{session.events.length ? <ol className="v2-events">{session.events.slice(-100).reverse().map((event) => <li key={event.id}><strong>{event.label}</strong><small>{event.kind} / state r{event.worldRevision}</small></li>)}</ol> : <p>No committed events.</p>}{session.events.length > 100 && <small>Latest 100 shown. Raw view and export contain the full ledger.</small>}</>}
      {tab === 'raw' && <section className="v2-instrument"><h3>Safe session state</h3><pre>{JSON.stringify(rawView, null, 2)}</pre></section>}
    </div>
    <div className="v2-diagnostic-actions"><button type="button" onClick={() => void navigator.clipboard?.writeText(copyOutput)}>Copy buffer</button></div>
  </aside>;
}

export { V3DiagnosticsPanel as V2DiagnosticsPanel };
