import { useEffect, useRef, useState } from 'react';
import { parseV2ClientPackage, type V2ClientPackage } from '../contracts/launch';
import { V2BrowserProvider } from '../providers/browser';
import { generateV2Turn, V2DraftRejected, type EnginePhase } from '../runtime/engine';
import { generateV2PersonaDraft } from '../runtime/persona-draft';
import { retractLatestTurnFromStudium, submitLatestTurnToStudium } from '../research/studium';
import { createV2Session, deleteLastTurn, operateWorld, type V2Diagnostics, type V2Session } from '../runtime/session';
import { acceptStateProposal, rejectStateProposal } from '../runtime/state-review';
import { loadLatestV2LocalAutosave, saveV2LocalAutosave } from '../storage/autosave';
import { exportV2Session, importV2Session, inspectV2Session, loadV2Session, MAX_V2_FILE_BYTES, saveV2Session, v2ExportFilename } from '../storage/session';
import { detachedTranscriptChannelName, type DetachedTranscriptMessage } from './detached-channel';
import { openFloatingReader, openSideReader, supportsFloatingReader } from './reader-window';
import { ToolMenu } from './ToolMenu';
import { V2DiagnosticsPanel } from './Diagnostics';
import { SettingsPanel } from './SettingsPanel';
import { V2Transcript } from './Transcript';

const PIPELINE_STEPS = ['resolve', 'context', 'generate', 'validate', 'commit'] as const;
const PENDING_IMPORT_KEY = 'speculus.pending-import.v3.experimental';

type PendingSaveIdentity = ReturnType<typeof inspectV2Session>;

let claim: { code: string; promise: Promise<V2ClientPackage> } | null = null;
function claimPackage(code: string) {
  if (claim?.code === code) return claim.promise;
  const promise = fetch(`/api/v2/launch/${encodeURIComponent(code)}`, { credentials: 'same-origin', cache: 'no-store' }).then(async (response) => {
    const body = await response.json() as { package?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error || 'V3 launch could not be claimed.');
    return parseV2ClientPackage(body.package);
  });
  claim = { code, promise };
  return promise;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'V3 could not complete this action.';

export function V2App() {
  const [session, setSession] = useState<V2Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [phase, setPhase] = useState<EnginePhase | null>(null);
  const [phaseSeen, setPhaseSeen] = useState<EnginePhase[]>([]);
  const [importing, setImporting] = useState(false);
  const [pendingSave, setPendingSave] = useState<PendingSaveIdentity | null>(null);
  const importLock = useRef(false);
  const [importRevision, setImportRevision] = useState(0);
  const [rejected, setRejected] = useState<V2Diagnostics | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [transcriptDetached, setTranscriptDetached] = useState(false);
  const [readerMode, setReaderMode] = useState<'inline' | 'side' | 'floating'>('inline');
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rootFileInput = useRef<HTMLInputElement>(null);
  const detachedWindow = useRef<Window | null>(null);
  const detachedChannel = useRef<BroadcastChannel | null>(null);
  const liveSession = useRef<V2Session | null>(null);
  const liveBusy = useRef(false);
  const busy = phase !== null || importing;
  const floatingReaderSupported = supportsFloatingReader();

  const notePhase = (next: EnginePhase) => {
    setPhase(next);
    setPhaseSeen((current) => current.includes(next) ? current : [...current, next]);
  };

  useEffect(() => {
    liveSession.current = session;
    liveBusy.current = busy;
  }, [session, busy]);

  useEffect(() => {
    let active = true;
    document.title = 'Speculus V3 | Simulation Laboratory';
    const code = new URLSearchParams(window.location.search).get('launch');
    void (async () => {
      try {
        let next = code ? createV2Session(await claimPackage(code)) : loadV2Session();
        if (code && next) {
          let pending = sessionStorage.getItem(PENDING_IMPORT_KEY);
          if (!pending) {
            const latest = loadLatestV2LocalAutosave();
            const source = latest?.identity;
            const primary = next.launch.primaryAsset;
            if (latest && source?.id === primary.id && source.type === primary.type && source.revision === primary.revision) {
              pending = latest.raw;
            }
          }
          if (pending) {
            try {
              next = importV2Session(pending, next);
              sessionStorage.removeItem(PENDING_IMPORT_KEY);
            } catch (cause) {
              setError(`The staged save was not loaded: ${messageOf(cause)}`);
            }
          }
        }
        if (active && next) {
          if (code) window.history.replaceState({}, '', window.location.pathname);
          setSession(next);
        }
      } catch (cause) { if (active) setError(messageOf(cause)); }
      finally { if (active) setBooting(false); }
    })();
    return () => { active = false; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!session) return;
    try {
      saveV2Session(session);
      saveV2LocalAutosave(session);
      setStorageError('');
    } catch {
      setStorageError('Local save storage is unavailable or full. Export your session now to preserve it.');
    }
  }, [session]);

  useEffect(() => {
    if (!session || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(detachedTranscriptChannelName(session.id));
    detachedChannel.current = channel;
    const sendState = () => {
      const current = liveSession.current;
      if (!current) return;
      channel.postMessage({ type: 'state', sessionId: current.id, session: current, busy: liveBusy.current } satisfies DetachedTranscriptMessage);
    };
    channel.onmessage = (event: MessageEvent<DetachedTranscriptMessage>) => {
      const message = event.data;
      if (!message || message.sessionId !== session.id) return;
      if (message.type === 'ready') {
        setTranscriptDetached(true);
        setReaderMode((current) => current === 'inline' ? 'side' : current);
        sendState();
      } else if (message.type === 'closed') {
        if (detachedWindow.current?.closed) detachedWindow.current = null;
        setTranscriptDetached(false);
        setReaderMode('inline');
      }
    };
    channel.postMessage({ type: 'probe', sessionId: session.id } satisfies DetachedTranscriptMessage);
    return () => {
      channel.close();
      if (detachedChannel.current === channel) detachedChannel.current = null;
    };
  }, [session?.id]);

  useEffect(() => {
    if (!session || !transcriptDetached) return;
    detachedChannel.current?.postMessage({ type: 'state', sessionId: session.id, session, busy } satisfies DetachedTranscriptMessage);
  }, [session?.turns, session?.settings.actionColor, session?.settings.dialogueColor, session?.settings.thoughtColor, session?.settings.crtEffects, busy, transcriptDetached]);

  useEffect(() => {
    if (!transcriptDetached) return;
    const timer = window.setInterval(() => {
      if (detachedWindow.current?.closed) {
        detachedWindow.current = null;
        setTranscriptDetached(false);
        setReaderMode('inline');
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [transcriptDetached]);

  const generate = async (reroll = false, skipPersona = false) => {
    if (!session || controller.current || importLock.current) return;
    const active = new AbortController();
    controller.current = active; setError(''); setRejected(null); setPhaseSeen([]);
    try {
      const next = await generateV2Turn(session, new V2BrowserProvider(session.launch.launchId), {
        reroll, skipPersona, signal: active.signal, onPhase: notePhase,
      });
      if (!active.signal.aborted) {
        setSession(next);
        void submitLatestTurnToStudium(next, { reroll }).catch(() => undefined);
      }
    } catch (cause) {
      setError(active.signal.aborted ? 'Cancelled. Your draft and committed state are unchanged.' : messageOf(cause));
      if (cause instanceof V2DraftRejected) setRejected(cause.diagnostics);
    } finally { controller.current = null; setPhase(null); }
  };

  const impersonate = async () => {
    if (!session || controller.current || importLock.current) return;
    const active = new AbortController();
    controller.current = active; setError(''); setRejected(null); setPhaseSeen([]);
    try {
      const draft = await generateV2PersonaDraft(session, new V2BrowserProvider(session.launch.launchId), {
        signal: active.signal, onPhase: notePhase,
      });
      if (!active.signal.aborted) setSession({ ...session, draft });
    } catch (cause) {
      setError(active.signal.aborted ? 'Cancelled. The player composer was unchanged.' : messageOf(cause));
    } finally { controller.current = null; setPhase(null); }
  };

  const ensureReaderChannel = () => {
    if (typeof BroadcastChannel !== 'undefined') return true;
    setError('This browser does not support the live channel required by the detached reader.');
    return false;
  };

  const openSideTranscript = () => {
    if (!session || !ensureReaderChannel()) return;
    if (readerMode === 'side' && detachedWindow.current && !detachedWindow.current.closed) {
      detachedWindow.current.focus();
      return;
    }

    detachedWindow.current?.close();
    const popup = openSideReader(session.id, 'speculus-v3-display');
    if (!popup) {
      setError('The browser blocked the side reader window. Allow pop-ups for Speculus and try again.');
      setTranscriptDetached(false);
      setReaderMode('inline');
      return;
    }

    detachedWindow.current = popup;
    setReaderMode('side');
    setTranscriptDetached(true);
    setError('');
    popup.focus();
  };

  const openFloatingTranscript = async () => {
    if (!session || !ensureReaderChannel()) return;
    if (!floatingReaderSupported) {
      setError('Always-on-top floating reader is unavailable in this browser. Use Pop out to side instead.');
      return;
    }
    if (readerMode === 'floating' && detachedWindow.current && !detachedWindow.current.closed) {
      detachedWindow.current.focus();
      return;
    }

    detachedWindow.current?.close();
    try {
      const popup = await openFloatingReader(session.id);
      detachedWindow.current = popup;
      setReaderMode('floating');
      setTranscriptDetached(true);
      setError('');
      popup.focus();
    } catch (cause) {
      detachedWindow.current = null;
      setTranscriptDetached(false);
      setReaderMode('inline');
      setError(messageOf(cause));
    }
  };

  const restoreTranscript = () => {
    detachedWindow.current?.close();
    detachedWindow.current = null;
    setTranscriptDetached(false);
    setReaderMode('inline');
    setError('');
  };

  const saveNow = () => {
    if (!session) return;
    try {
      saveV2Session(session);
      saveV2LocalAutosave(session);
      setStorageError('');
      setError('');
    } catch {
      setStorageError('Local save storage is unavailable or full. Export your session now to preserve it.');
    }
  };

  const startNewSimulation = () => {
    if (!session || busy) return;
    if (!window.confirm('Start a new simulation with this Orbis package? The current working session will be replaced by the new autosave. Export it first if you want to keep it.')) return;
    controller.current?.abort();
    detachedWindow.current?.close();
    detachedWindow.current = null;
    sessionStorage.removeItem(PENDING_IMPORT_KEY);
    setTranscriptDetached(false);
    setReaderMode('inline');
    setRejected(null);
    setError('');
    setStorageError('');
    setPhaseSeen([]);
    setImportRevision((value) => value + 1);
    setSession(createV2Session(session.launch));
  };

  const download = () => {
    if (!session) return;
    try {
      const url = URL.createObjectURL(new Blob([exportV2Session(session)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = v2ExportFilename(session);
      anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(messageOf(cause)); }
  };

  const importFile = async (file: File) => {
    if (!session || controller.current || importLock.current) return;
    if (file.size > MAX_V2_FILE_BYTES) { setError('V3 imports are limited to 16 MB.'); return; }
    importLock.current = true; setImporting(true);
    try {
      const next = importV2Session(await file.text(), session);
      if (!window.confirm('Replace this V3 session with the imported transcript and state? Export the current session first if you want to keep it. V1 is unaffected.')) return;
      setSession(next); setImportRevision((value) => value + 1); setRejected(null); setError('');
    } catch (cause) { setError(messageOf(cause)); }
    finally { importLock.current = false; setImporting(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  const stageRootSave = async (file?: File) => {
    if (!file) return;
    if (file.size > MAX_V2_FILE_BYTES) { setError('V3 imports are limited to 16 MB.'); return; }
    try {
      const raw = await file.text();
      const identity = inspectV2Session(raw);
      sessionStorage.setItem(PENDING_IMPORT_KEY, raw);
      setPendingSave(identity);
      setError('');
    } catch (cause) {
      setPendingSave(null);
      setError(messageOf(cause));
    } finally {
      if (rootFileInput.current) rootFileInput.current.value = '';
    }
  };

  const expired = session ? session.launch.expiresAt <= Date.now() : false;
  return <main className={`spec-v2 ${session?.settings.crtEffects !== false ? 'v2-crt' : ''}`}>
    <header className="v2-masthead"><div><div className="v2-brand"><h1>SPECULUS</h1><span>V3</span><span className="v2-badge">Experimental / World Brain lab</span></div><p>Howling Whispers / Simulation lab</p></div>
      <div className="v2-connection"><span>{session ? 'ORBIS LINK' : 'SYSTEM MEDIUM'}</span><small>{session ? expired ? 'Authorization expired' : 'Package loaded' : 'Orbis launch or raw save'}</small>
        {session && <nav aria-label="Panel visibility"><button type="button" aria-pressed={showSettings} onClick={() => setShowSettings(!showSettings)}>Setup</button><button type="button" aria-pressed={showDiagnostics} onClick={() => setShowDiagnostics(!showDiagnostics)}>Diagnostics</button></nav>}
      </div>
    </header>
    {session ? <div className={`v2-layout ${showSettings ? '' : 'v2-hide-settings'} ${showDiagnostics ? '' : 'v2-hide-diagnostics'}`}>
      {showSettings && <SettingsPanel key={`${session.id}:${importRevision}`} session={session} disabled={busy} onSettings={(patch) => setSession({ ...session, settings: { ...session.settings, ...patch } })} onWorld={(action) => {
        try { setSession(operateWorld(session, action)); setError(''); }
        catch (cause) { setError(messageOf(cause)); }
      }} />}
      <section className={`v2-panel v2-simulation ${transcriptDetached ? 'v2-transcript-detached' : ''}`} aria-label="Simulation">
        <header className="v2-panel-heading"><h2>Simulation</h2><span>{session.launch.primaryAsset.name}</span></header>
        {!transcriptDetached && <V2Transcript session={session} busy={busy} />}
        <div className="v2-transcript-tools">
          <button disabled={busy || !session.turns.length || expired || session.turns.at(-1)?.worldRevision !== session.world.revision} onClick={() => void generate(true)}>Reroll latest</button>
          <button disabled={busy || expired} onClick={() => void impersonate()}>Impersonate</button>
          <ToolMenu label="Turn">
              <button disabled={busy || expired} onClick={() => void generate(false, true)}>Skip persona turn</button>
              <button className="v2-delete" disabled={busy || !session.turns.length || session.turns.at(-1)?.worldRevision !== session.world.revision} onClick={() => {
                if (window.confirm('Remove the latest player/reply pair and its resolved state from this V3 session?')) {
                  void retractLatestTurnFromStudium(session).catch(() => undefined);
                  setSession(deleteLastTurn(session));
                  setRejected(null);
                }
              }}>Delete latest</button>

          </ToolMenu>
          <ToolMenu label="Session">
              <button type="button" onClick={openSideTranscript}>{readerMode === 'side' && transcriptDetached ? 'Focus side reader' : 'Pop out to side'}</button>
              <button type="button" disabled={!floatingReaderSupported} onClick={() => void openFloatingTranscript()}>{readerMode === 'floating' && transcriptDetached ? 'Focus floating reader' : 'Float always on top'}</button>
              {transcriptDetached && <button type="button" onClick={restoreTranscript}>Return reader here</button>}
              <button disabled={busy || expired} onClick={startNewSimulation}>New simulation</button>
              <button disabled={busy} onClick={saveNow}>Save now</button>
              <button disabled={busy} onClick={download}>Export raw</button>
              <button disabled={busy} onClick={() => fileInput.current?.click()}>Import raw</button>

          </ToolMenu>
          <input hidden ref={fileInput} type="file" accept=".json,application/json" aria-label="Import V3 session" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
        </div>
        {session.stateProposals.length > 0 && <section className="v2-state-review" aria-label="State review">
          <header><div><span className="v2-eyebrow">Review only</span><h3>State proposals</h3></div><strong>{session.stateProposals.length}</strong></header>
          <small>Speculus noticed possible state changes in committed prose. Nothing below is authoritative until you accept it.</small>
          <div className="v2-state-review-list">
            {session.stateProposals.map((proposal) => <article key={proposal.id}>
              <p>{proposal.summary}</p>
              <small>{proposal.kind} · source {proposal.sourceTurnId}</small>
              <div>
                <button type="button" disabled={busy} onClick={() => {
                  try { setSession(acceptStateProposal(session, proposal.id)); setError(''); }
                  catch (cause) { setError(messageOf(cause)); }
                }}>Accept</button>
                <button type="button" disabled={busy} onClick={() => setSession(rejectStateProposal(session, proposal.id))}>Reject</button>
              </div>
            </article>)}
          </div>
        </section>}
        {transcriptDetached && <div className="v2-detached-note"><span>{readerMode === 'floating' ? 'Floating reader active' : 'Reader popped out to side'}</span><small>{readerMode === 'floating' ? 'Always-on-top reading display. Closing it restores the transcript here.' : 'Move the reader beside Speculus or onto another monitor. Closing it restores the transcript here.'}</small></div>}
        {(error || storageError || expired) && <div className="v2-fault" role="alert">{storageError || error || 'Authorization expired. Export this session, launch the same record from Orbis, then import the V3 export.'}</div>}
        <form className="v2-composer" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
          <textarea aria-label="Your next turn" placeholder="What do you do next?" value={session.draft} maxLength={16000} disabled={busy} onChange={(event) => setSession({ ...session, draft: event.target.value })} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!busy && session.draft.trim() && !expired) void generate();
            }
          }} />
          <div><small>Enter to send · Shift+Enter for newline{transcriptDetached ? ' / detached reader live' : ''}</small>{busy ? <button type="button" onClick={() => controller.current?.abort()}>Cancel</button> : <button className="v2-send" disabled={!session.draft.trim() || expired}>Send</button>}</div>
        </form>
      </section>
      {showDiagnostics && <V2DiagnosticsPanel session={session} rejected={rejected} />}
    </div> : <section className="v2-panel v2-boot">
      <span className="v2-eyebrow">V3 / BOOT SEQUENCE</span>
      <h2>{booting ? 'Reading simulation medium...' : pendingSave ? 'Save identified' : 'Open a simulation or load a save'}</h2>
      {booting ? <p role="status">Checking this tab for a launch package or existing V3 session.</p> : pendingSave ? <>
        <p role="status">{pendingSave.name ?? pendingSave.world?.name ?? 'Speculus save'} · {pendingSave.location?.name ?? 'no saved location'} · {pendingSave.persona?.name ?? 'saved persona'}</p>
        <p>The raw save is staged in this tab. Open its matching Orbis record at revision <strong>{pendingSave.revision}</strong> and choose Simulate. Speculus will consume the staged save automatically after Orbis issues fresh authorization.</p>
        <button type="button" onClick={() => rootFileInput.current?.click()}>Choose a different raw save</button>
      </> : <>
        <p>Start from Orbis as usual, or identify a previously exported V3 save here. Raw saves never contain reusable launch authorization.</p>
        <button type="button" onClick={() => rootFileInput.current?.click()}>Load raw save</button>
      </>}
      {error && <div className="v2-fault" role="alert">{error}</div>}
      <input hidden ref={rootFileInput} type="file" accept=".json,application/json" aria-label="Load V3 raw save" onChange={(event) => void stageRootSave(event.target.files?.[0])} />
      <small>V1 and V3 sessions are separate. No V1 data has been loaded or modified.</small>
    </section>}
    <footer className="v2-status" aria-live="polite"><div>{PIPELINE_STEPS.map((step) => <span key={step} className={phase === step ? 'is-active' : phaseSeen.includes(step) ? 'is-complete' : ''}><i />{step}</span>)}</div><span>{phase ? phase.toUpperCase() : error || storageError ? 'FAULT' : session ? expired ? 'RELAUNCH REQUIRED' : transcriptDetached ? 'READER DETACHED' : 'READY' : pendingSave ? 'SAVE STAGED' : 'STANDBY'}</span><small>/v3</small></footer>
  </main>;
}
