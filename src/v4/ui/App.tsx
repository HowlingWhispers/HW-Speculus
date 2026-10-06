import { useEffect, useRef, useState } from 'react';
import { parseV4ClientPackage, type V4ClientPackage } from '../contracts/launch';
import { V4BrowserProvider } from '../providers/browser';
import { V4DraftRejected, type EnginePhase } from '../runtime/engine';
import { generateV4PersonaDraft } from '../runtime/persona-draft';
import { retractBranchTurnFromStudium, submitBranchTurnToStudium } from '../research/studium';
import { createV4Session, operateWorld, type V4Diagnostics, type V4Session } from '../runtime/session';
import { acceptStateProposal, rejectStateProposal } from '../runtime/state-review';
import { loadLatestV4LocalAutosave } from '../storage/autosave';
import { inspectV4Session, loadV4Session, MAX_V4_FILE_BYTES } from '../storage/session';
import { exportBranch, importBranchFile, inspectBranchFile, branchExportFilename } from '../storage/branch-transfer';
import { loadV4Authorization, saveV4Authorization } from '../storage/authorization';
import { detachedTranscriptChannelName, type DetachedTranscriptMessage } from './detached-channel';
import { openFloatingReader, openSideReader, supportsFloatingReader } from './reader-window';
import { usePhoneLayout } from './usePhoneLayout';
import { ToolMenu } from './ToolMenu';
import { V4DiagnosticsPanel } from './Diagnostics';
import { SettingsPanel } from './SettingsPanel';
import { V4Transcript } from './Transcript';
import { useSpeechSynthesis } from './useSpeechSynthesis';
import { isSkippedPersonaTurn } from '../runtime/turn-control';
import { BranchImportCollision, useBranchController } from './useBranchController';
import { BranchSwitcher } from './BranchSwitcher';
import { deleteLatestAsBranch, editTurn, forkBranch, generateAlternative, selectPage } from '../runtime/branches';
import type { V4Branch } from '../runtime/branches';
import { loadActiveBranch } from '../storage/branches';

const PIPELINE_STEPS = ['resolve', 'context', 'generate', 'validate', 'commit'] as const;
const PENDING_IMPORT_KEY = 'speculus.pending-import.v4';

type PendingSaveIdentity = ReturnType<typeof inspectV4Session>;
type ClaimedLaunch = { package: V4ClientPackage; resumeSave?: unknown };

let claim: { code: string; promise: Promise<ClaimedLaunch> } | null = null;
function claimPackage(code: string) {
  if (claim?.code === code) return claim.promise;
  const promise = fetch(`/api/v4/launch/${encodeURIComponent(code)}`, { credentials: 'same-origin', cache: 'no-store' }).then(async (response) => {
    const body = await response.json() as { package?: unknown; resumeSave?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error || 'V4 launch could not be claimed.');
    return { package: parseV4ClientPackage(body.package), ...(body.resumeSave === undefined ? {} : { resumeSave: body.resumeSave }) };
  });
  claim = { code, promise };
  return promise;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'V4 could not complete this action.';

export function V4App() {
  const [session, setSession] = useState<V4Session | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [phase, setPhase] = useState<EnginePhase | null>(null);
  const [phaseSeen, setPhaseSeen] = useState<EnginePhase[]>([]);
  const [importing, setImporting] = useState(false);
  const [pendingSave, setPendingSave] = useState<PendingSaveIdentity | null>(null);
  const [recoveryBranch, setRecoveryBranch] = useState<V4Branch | null>(null);
  const importLock = useRef(false);
  const [importRevision, setImportRevision] = useState(0);
  const [rejected, setRejected] = useState<V4Diagnostics | null>(null);
  const isPhone = usePhoneLayout();
  const [phoneTab, setPhoneTab] = useState<'main' | 'setup' | 'diagnostics'>('main');
  const [showSettings, setShowSettings] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [transcriptDetached, setTranscriptDetached] = useState(false);
  const [readerMode, setReaderMode] = useState<'inline' | 'side' | 'floating'>('inline');
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rootFileInput = useRef<HTMLInputElement>(null);
  const detachedWindow = useRef<Window | null>(null);
  const detachedChannel = useRef<BroadcastChannel | null>(null);
  const liveBusy = useRef(false);
  const busy = phase !== null || importing;
  const floatingReaderSupported = supportsFloatingReader();
  const speech = useSpeechSynthesis();
  const { stop: stopSpeech } = speech;
  const branchController = useBranchController(setSession);
  const adoptImported = async (candidate: V4Branch, receiving: V4Session) => {
    try { return await branchController.importBranch(candidate, receiving); }
    catch (cause) {
      if (!(cause instanceof BranchImportCollision)) throw cause;
      if (!window.confirm(`Replace the exact saved branch ${cause.branchId} with this imported content? Other branches will not change.`)) {
        throw new Error('Import cancelled. The existing branch was not changed.');
      }
      return branchController.importBranch(candidate, receiving, true);
    }
  };
  const [readerConnectionId] = useState(() => crypto.randomUUID());
  const readerSequence = useRef(0);
  const liveBranchId = useRef<string | null>(null);
  liveBranchId.current = branchController.branch?.branchId ?? null;
  const liveReaderView = useRef<V4Session | null>(null);
  const readerSession = (value: V4Session): V4Session => ({ ...value,
    launch: { ...value.launch, launchId: 'detached-reader', expiresAt: 0 },
    turns: value.turns.map((turn) => {
      const selected = previews[turn.id];
      const page = branchController.branch?.turns.find((item) => item.id === turn.id)?.pages.find((item) => item.id === selected);
      return page ? { ...turn, player: page.player ?? turn.player, reply: page.reply, diagnostics: page.diagnostics, createdAt: page.createdAt, worldRevision: page.worldRevision } : turn;
    }),
  });
  useEffect(() => { liveReaderView.current = session ? readerSession(session) : null; }, [session, previews, branchController.branch]);
  const update = (transform: (value: V4Session) => V4Session, label: string, sourceTurnId?: string) => {
    const turn = branchController.branch?.turns.find((value) => value.id === sourceTurnId);
    const source = turn ? { turnId: turn.id, pageId: turn.activePageId } : undefined;
    void branchController.update(transform, label, source).then(() => setStorageError('')).catch((cause) => setStorageError(messageOf(cause)));
  };

  useEffect(() => {
    if (!session?.settings.speechEnabled) stopSpeech();
  }, [session?.settings.speechEnabled, stopSpeech]);
  useEffect(() => { stopSpeech(); }, [session?.id, stopSpeech]);
  useEffect(() => { stopSpeech(); }, [branchController.branch?.branchId, stopSpeech]);
  useEffect(() => { setComposerDraft(session?.draft ?? ''); }, [branchController.branch?.branchId]);
  useEffect(() => { setPreviews({}); }, [branchController.branch?.branchId]);

  const notePhase = (next: EnginePhase) => {
    setPhase(next);
    setPhaseSeen((current) => current.includes(next) ? current : [...current, next]);
  };

  useEffect(() => {
    liveBusy.current = busy;
  }, [busy]);

  useEffect(() => {
    let active = true;
    document.title = 'Speculus V4 | Simulation Laboratory';
    const code = new URLSearchParams(window.location.search).get('launch');
    void (async () => {
      try {
        const claimed = code ? await claimPackage(code) : null;
        const storedLaunch = claimed ? null : loadV4Authorization();
        let next = claimed ? createV4Session(claimed.package) : storedLaunch ? createV4Session(storedLaunch) : loadV4Session();
        let imported: V4Branch | null = null;
        if (code && next) {
          let pending = claimed?.resumeSave === undefined ? sessionStorage.getItem(PENDING_IMPORT_KEY) : JSON.stringify(claimed.resumeSave);
          if (!pending) {
            const latest = loadLatestV4LocalAutosave();
            const source = latest?.identity;
            const primary = next.launch.primaryAsset;
            if (latest && source?.id === primary.id && source.type === primary.type && source.revision === primary.revision) {
              pending = latest.raw;
            }
          }
          if (pending) {
            try {
              imported = importBranchFile(pending, next.launch);
            } catch (cause) {
              setError(`The staged save was not loaded: ${messageOf(cause)}`);
            }
          }
        }
        if (active && next) {
          if (code) window.history.replaceState({}, '', window.location.pathname);
          if (imported) {
            await adoptImported(imported, next);
            sessionStorage.removeItem(PENDING_IMPORT_KEY);
          } else await branchController.initialize(next, true);
        } else if (active) {
          const saved = await loadActiveBranch();
          if (active && saved) {
            setRecoveryBranch(saved.branch);
            const source = saved.sourceIdentity;
            setPendingSave({ id: source.sourceId, type: source.sourceType, revision: source.sourceRevision, name: saved.branch.label,
              persona: { id: source.personaId, name: source.personaId } });
          }
        }
      } catch (cause) { if (active) setError(messageOf(cause)); }
      finally { if (active) setBooting(false); }
    })();
    return () => { active = false; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!session) return;
    try {
      saveV4Authorization(session.launch);
      setStorageError('');
    } catch {
      setStorageError('Local save storage is unavailable or full. Export your session now to preserve it.');
    }
  }, [session]);

  useEffect(() => {
    if (!session || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(detachedTranscriptChannelName(readerConnectionId));
    detachedChannel.current = channel;
    const sendState = () => {
      const current = liveReaderView.current;
      if (!current || !liveBranchId.current) return;
      channel.postMessage({ type: 'state', sessionId: readerConnectionId, branchId: liveBranchId.current, sequence: ++readerSequence.current, session: current, busy: liveBusy.current } satisfies DetachedTranscriptMessage);
    };
    channel.onmessage = (event: MessageEvent<DetachedTranscriptMessage>) => {
      const message = event.data;
      if (!message || message.sessionId !== readerConnectionId) return;
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
    channel.postMessage({ type: 'probe', sessionId: readerConnectionId } satisfies DetachedTranscriptMessage);
    return () => {
      channel.close();
      if (detachedChannel.current === channel) detachedChannel.current = null;
    };
  }, [Boolean(session), readerConnectionId]);

  useEffect(() => {
    if (!session || !transcriptDetached || !branchController.branch) return;
    detachedChannel.current?.postMessage({ type: 'state', sessionId: readerConnectionId, branchId: branchController.branch.branchId, sequence: ++readerSequence.current, session: readerSession(session), busy } satisfies DetachedTranscriptMessage);
  }, [session, previews, branchController.branch, busy, transcriptDetached, readerConnectionId]);

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

  const generate = async (reroll = false, skipPersona = false, skipAsActorId?: string) => {
    if (reroll) {
      const latest = branchController.branch?.turns.at(-1);
      if (latest) await historyAction('alternative', latest.id);
      return;
    }
    if (!session || controller.current || importLock.current) return;
    const active = new AbortController();
    controller.current = active; setError(''); setRejected(null); setPhaseSeen([]);
    try {
      const next = await branchController.generate(new V4BrowserProvider(session.launch.launchId), {
        skipPersona, skipAsActorId, signal: active.signal, onPhase: notePhase,
      });
      setComposerDraft(next.draft);
      const committed = branchController.currentBranch();
      if (committed) void submitBranchTurnToStudium(committed, next.launch).catch(() => undefined);
      if (!active.signal.aborted) {
        const latest = next.turns.at(-1);
        if (next.settings.speechEnabled && latest && !isSkippedPersonaTurn(latest.player)) {
          speech.speak(latest.reply, { rate: next.settings.speechRate, voiceUri: next.settings.speechVoiceUri });
        }
      } else setError('The turn was already durably committed before cancellation completed.');
    } catch (cause) {
      setError(active.signal.aborted ? 'Cancelled. Your draft and committed state are unchanged.' : messageOf(cause));
      if (cause instanceof V4DraftRejected) setRejected(cause.diagnostics);
    } finally { controller.current = null; setPhase(null); }
  };

  const historyAction = async (kind: 'alternative' | 'select' | 'fork' | 'edit' | 'delete', turnId: string, pageId?: string, changes?: { player?: string; reply?: string }): Promise<void> => {
    if (!session || controller.current || importLock.current) return;
    if (kind === 'edit' && !window.confirm('Commit this history edit? Older or unsafe changes create a child branch. Original pages and parent futures remain saved.')) return;
    if (kind === 'delete' && !window.confirm('Continue in a new branch before the latest turn? The original turn and future remain saved on the parent.')) return;
    const active = new AbortController();
    controller.current = active; stopSpeech(); setError(''); setRejected(null); setPhaseSeen([]); notePhase('context');
    try {
      await branchController.settle();
      const previous = branchController.currentBranch();
      if (!previous || previous.branchId !== branchController.branch?.branchId) throw new Error('The active branch changed before this operation.');
      const provider = new V4BrowserProvider(session.launch.launchId);
      const options = { signal: active.signal, onPhase: notePhase };
      const candidate = kind === 'alternative' ? await generateAlternative(previous, session.launch, provider, turnId, options)
        : kind === 'edit' ? await editTurn(previous, session.launch, provider, turnId, { ...changes, ...options })
          : kind === 'select' ? selectPage(previous, turnId, pageId!)
            : kind === 'delete' ? deleteLatestAsBranch(previous)
              : forkBranch(previous, turnId, pageId);
      notePhase('commit');
      const committed = await branchController.commit(candidate, previous, active.signal);
      if (active.signal.aborted) setError('The outcome was already durably committed before cancellation completed.');
      if (kind === 'alternative') {
        const page = committed.turns.find((turn) => turn.id === turnId)?.pages.at(-1);
        if (page) setPreviews((value) => ({ ...value, [turnId]: page.id }));
      } else {
        setPreviews({});
        setComposerDraft(committed.draft);
        if (kind !== 'delete' && committed.frontier) {
          if (committed.branchId === previous.branchId) {
            void retractBranchTurnFromStudium(previous, session.launch, turnId).catch(() => undefined);
          }
          void submitBranchTurnToStudium(committed, session.launch, turnId).catch(() => undefined);
        }
      }
    } catch (cause) {
      setError(active.signal.aborted ? 'Cancelled. Your existing branch and pages are unchanged.' : messageOf(cause));
      if (cause instanceof V4DraftRejected) setRejected(cause.diagnostics);
      if (kind === 'edit') throw cause;
    } finally { controller.current = null; setPhase(null); }
  };

  const impersonate = async () => {
    if (!session || controller.current || importLock.current) return;
    const active = new AbortController();
    controller.current = active; setError(''); setRejected(null); setPhaseSeen([]);
    try {
      const draft = await generateV4PersonaDraft(session, new V4BrowserProvider(session.launch.launchId), {
        signal: active.signal, onPhase: notePhase,
      });
      if (!active.signal.aborted) {
        await branchController.update((value) => ({ ...value, draft }), 'persona-draft');
        setComposerDraft(draft);
      }
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
    const popup = openSideReader(readerConnectionId, 'speculus-v4-display');
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
      const popup = await openFloatingReader(readerConnectionId);
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

  const saveNow = async () => {
    if (!session) return;
    try {
      const saved = await branchController.settle();
      if (!saved || saved.draft !== composerDraft) throw new Error('The current draft has not been saved.');
      saveV4Authorization(saved.launch);
      setStorageError('');
      setError('');
    } catch {
      setStorageError('Local save storage is unavailable or full. Export your session now to preserve it.');
    }
  };

  const startNewSimulation = () => {
    if (!session || busy) return;
    if (!window.confirm('Start a new story with this Orbis package? Your existing saved stories and branches will remain available.')) return;
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
    void branchController.initialize(createV4Session(session.launch), false).catch((cause) => setStorageError(messageOf(cause)));
  };

  const download = async () => {
    try {
      await branchController.settle();
      const selected = branchController.currentBranch() ?? recoveryBranch;
      if (!selected) return;
      const url = URL.createObjectURL(new Blob([exportBranch(selected, session?.launch)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = branchExportFilename(selected);
      anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(messageOf(cause)); }
  };

  const importFile = async (file: File) => {
    if (!session || controller.current || importLock.current) return;
    if (file.size > MAX_V4_FILE_BYTES) { setError('V4 imports are limited to 16 MB.'); return; }
    importLock.current = true; setImporting(true);
    try {
      const next = importBranchFile(await file.text(), session.launch);
      if (!window.confirm('Open the imported branch? Existing stories and other branches remain saved.')) return;
      stopSpeech();
      await adoptImported(next, session); setImportRevision((value) => value + 1); setRejected(null); setError('');
    } catch (cause) { setError(messageOf(cause)); }
    finally { importLock.current = false; setImporting(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  const stageRootSave = async (file?: File) => {
    if (!file) return;
    if (file.size > MAX_V4_FILE_BYTES) { setError('V4 imports are limited to 16 MB.'); return; }
    try {
      const raw = await file.text();
      const inspected = inspectBranchFile(raw);
      const identity: PendingSaveIdentity = { ...inspected,
        persona: { id: inspected.persona.id, name: inspected.persona.id },
        character: inspected.character ? { id: inspected.character.id, name: inspected.character.id } : null };
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
  const skipAsActors = session?.world.actors.filter((actor) => actor.role === 'character') ?? [];
  return <main className={`spec-v2 ${isPhone && session ? 'v3-phone' : ''} ${session?.settings.crtEffects !== false ? 'v2-crt' : ''}`}>
    <header className="v2-masthead"><div><div className="v2-brand"><h1>SPECULUS</h1><span>V4</span><span className="v2-badge">Experimental / World Brain lab</span></div><p>Howling Whispers / Simulation lab</p></div>
      <div className="v2-connection"><span>{session ? 'ORBIS LINK' : 'SYSTEM MEDIUM'}</span><small>{session ? expired ? 'Authorization expired' : 'Package loaded' : 'Orbis launch or raw save'}</small>
        {session && !isPhone && <nav aria-label="Panel visibility"><button type="button" aria-pressed={showSettings} onClick={() => setShowSettings(!showSettings)}>Setup</button><button type="button" aria-pressed={showDiagnostics} onClick={() => setShowDiagnostics(!showDiagnostics)}>Diagnostics</button></nav>}
      </div>
    </header>
    {session && isPhone && <nav className="v3-phone-tabs" aria-label="Simulation screens">
      {(['main', 'setup', 'diagnostics'] as const).map((tab) => <button key={tab} type="button" aria-pressed={phoneTab === tab} onClick={() => setPhoneTab(tab)}>{tab === 'main' ? 'Main' : tab === 'setup' ? 'Setup' : 'Diagnostics'}</button>)}
      <button type="button" disabled={busy} onClick={() => {
        try {
          saveV4Authorization(session.launch);
          window.location.assign(`https://lib.thehowlingwhispers.com/asset/${encodeURIComponent(session.launch.primaryAsset.id)}`);
        } catch { setPhoneTab('main'); setStorageError('Could not save before leaving. Return to Main and export your session first.'); }
      }}>Back to Orbis</button>
    </nav>}
    {session ? <div data-phone-tab={phoneTab} className={`v2-layout ${showSettings ? '' : 'v2-hide-settings'} ${showDiagnostics ? '' : 'v2-hide-diagnostics'}`}>
      {(isPhone || showSettings) && <SettingsPanel key={`${branchController.branch?.branchId}:${importRevision}`} session={session} disabled={busy} speech={speech} onSettings={(patch) => update((value) => ({ ...value, settings: { ...value.settings, ...patch } }), 'settings')} onWorld={(action) => update((value) => operateWorld(value, action), action.type)} />}
      <section className={`v2-panel v2-simulation ${transcriptDetached ? 'v2-transcript-detached' : ''}`} aria-label="Simulation">
        <header className="v2-panel-heading"><h2>Simulation</h2><span>{session.launch.primaryAsset.name}</span></header>
        {branchController.branch && <BranchSwitcher branches={branchController.branches} activeBranchId={branchController.branch.branchId} disabled={busy} onSwitch={(id) => {
          stopSpeech();
          void branchController.switchTo(id).catch((cause) => setStorageError(messageOf(cause)));
        }} />}
        {!transcriptDetached && <V4Transcript key={branchController.branch?.branchId} session={session} busy={busy} speech={speech} branch={branchController.branch ?? undefined} previews={previews}
          onPreview={(turnId, pageId) => { stopSpeech(); setPreviews((value) => ({ ...value, [turnId]: pageId })); }}
          onAlternative={(turnId) => void historyAction('alternative', turnId)} onContinue={(turnId, pageId) => void historyAction('select', turnId, pageId)}
          onEdit={(turnId, changes) => historyAction('edit', turnId, undefined, changes)} onFork={(turnId, pageId) => void historyAction('fork', turnId, pageId)}
          canFork={(turnId) => Boolean(branchController.branch?.turns.find((turn) => turn.id === turnId)?.pages.some((page) => page.after))} />}
        <div className="v2-transcript-tools">
          <button disabled={busy || expired || !branchController.branch?.turns.at(-1)?.pages.some((page) => page.before)} onClick={() => void generate(true)}>Reroll latest</button>
          <button disabled={busy || expired} onClick={() => void impersonate()}>Impersonate</button>
          <ToolMenu label="Skip as">
              {skipAsActors.map((actor) => <button key={actor.id} disabled={busy || expired} onClick={() => void generate(false, true, actor.id)}>{actor.name}</button>)}
              <button disabled={busy || expired} onClick={() => void generate(false, true)}>Narrator / automatic</button>
              {!skipAsActors.length && <button disabled>No NPCs identified</button>}
          </ToolMenu>
          <ToolMenu label="Turn">
              <button className="v2-delete" disabled={busy || !branchController.branch?.turns.at(-1)?.pages.some((page) => page.before)} onClick={() => {
                const latest = branchController.branch?.turns.at(-1);
                if (latest) void historyAction('delete', latest.id);
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
          <input hidden ref={fileInput} type="file" accept=".json,application/json" aria-label="Import V4 session" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
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
                  update((value) => acceptStateProposal(value, proposal.id), 'proposal-accepted', proposal.sourceTurnId);
                }}>Accept</button>
                <button type="button" disabled={busy} onClick={() => update((value) => rejectStateProposal(value, proposal.id), 'proposal-rejected', proposal.sourceTurnId)}>Reject</button>
              </div>
            </article>)}
          </div>
        </section>}
        {transcriptDetached && <div className="v2-detached-note"><span>{readerMode === 'floating' ? 'Floating reader active' : 'Reader popped out to side'}</span><small>{readerMode === 'floating' ? 'Always-on-top reading display. Closing it restores the transcript here.' : 'Move the reader beside Speculus or onto another monitor. Closing it restores the transcript here.'}</small></div>}
        {(error || storageError || expired) && <div className="v2-fault" role="alert">{storageError || error || 'Authorization expired. Export this session, launch the same record from Orbis, then import the V4 export.'}</div>}
        {branchController.conflict && <div className="v2-fault" role="alert"><p>Another tab changed this saved branch. Nothing was overwritten.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload saved state</button>
          <button type="button" onClick={() => void branchController.preserveConflict().then(() => setStorageError('')).catch((cause) => setStorageError(messageOf(cause)))}>Preserve candidate as new branch</button>
        </div>}
        <form className="v2-composer" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
          <textarea aria-label="Your next turn" placeholder="What do you do next?" value={composerDraft} maxLength={16000} disabled={busy} onChange={(event) => {
            const draft = event.target.value;
            setComposerDraft(draft);
            update((value) => ({ ...value, draft }), 'draft');
          }} onKeyDown={(event) => {
            if (!isPhone && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!busy && composerDraft.trim() && !expired) void generate();
            }
          }} />
          <div><small>{isPhone ? 'Enter for newline · Tap Send to send' : 'Enter to send · Shift+Enter for newline'}{transcriptDetached ? ' / detached reader live' : ''}</small>{busy ? <button type="button" onClick={() => controller.current?.abort()}>Cancel</button> : <button className="v2-send" disabled={!composerDraft.trim() || expired}>Send</button>}</div>
        </form>
      </section>
      {(isPhone || showDiagnostics) && <V4DiagnosticsPanel session={session} rejected={rejected} branch={branchController.branch} />}
    </div> : <section className="v2-panel v2-boot">
      <span className="v2-eyebrow">V4 / BOOT SEQUENCE</span>
      <h2>{booting ? 'Reading simulation medium...' : pendingSave ? 'Save identified' : 'Open a simulation or load a save'}</h2>
      {booting ? <p role="status">Checking this tab for a launch package or existing V4 session.</p> : pendingSave ? <>
        <p role="status">{pendingSave.name ?? pendingSave.world?.name ?? 'Speculus save'} · {pendingSave.location?.name ?? 'no saved location'} · {pendingSave.persona?.name ?? 'saved persona'}</p>
        <p>{recoveryBranch ? 'A durable V4 branch is available without reusable authorization.' : 'The raw save is staged in this tab.'} Open its matching Orbis record at revision <strong>{pendingSave.revision}</strong> and choose Simulate. Speculus will restore the save after Orbis issues fresh authorization.</p>
        <button type="button" onClick={() => rootFileInput.current?.click()}>Choose a different raw save</button>
        {recoveryBranch && <button type="button" onClick={() => void download()}>Export recovered branch</button>}
      </> : <>
        <p>Start from Orbis as usual, or identify a previously exported V4 save here. Raw saves never contain reusable launch authorization.</p>
        <button type="button" onClick={() => rootFileInput.current?.click()}>Load raw save</button>
      </>}
      {error && <div className="v2-fault" role="alert">{error}</div>}
      <input hidden ref={rootFileInput} type="file" accept=".json,application/json" aria-label="Load V4 raw save" onChange={(event) => void stageRootSave(event.target.files?.[0])} />
      <small>V1 and V4 sessions are separate. No V1 data has been loaded or modified.</small>
    </section>}
    <footer className="v2-status" aria-live="polite"><div>{PIPELINE_STEPS.map((step) => <span key={step} className={phase === step ? 'is-active' : phaseSeen.includes(step) ? 'is-complete' : ''}><i />{step}</span>)}</div><span>{phase ? phase.toUpperCase() : error || storageError ? 'FAULT' : session ? expired ? 'RELAUNCH REQUIRED' : transcriptDetached ? 'READER DETACHED' : 'READY' : pendingSave ? 'SAVE STAGED' : 'STANDBY'}</span><small>/v4</small></footer>
  </main>;
}
