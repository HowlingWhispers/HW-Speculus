import { useEffect, useRef, useState } from 'react';
import { loadLatestV4LocalAutosave, saveV4LocalAutosave } from '../storage/autosave';
import { exportV4Session, loadV4Session, v4ExportFilename } from '../storage/session';
import './autosave.css';

const PENDING_IMPORT_KEY = 'speculus.pending-import.v4';
type SaveState = 'standby' | 'saved' | 'fault';

function signatureOf(session: NonNullable<ReturnType<typeof loadV4Session>>) {
  const last = session.turns.at(-1);
  return JSON.stringify([
    session.id,
    session.world.revision,
    session.turns.length,
    session.events.length,
    session.nextTurn,
    last?.id ?? '',
    last?.reply ?? '',
    session.draft,
    session.settings,
  ]);
}

export function V4AutosaveControls() {
  const [state, setState] = useState<SaveState>('standby');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [recoveryLabel, setRecoveryLabel] = useState('');
  const lastSignature = useRef('');

  const persist = (session: NonNullable<ReturnType<typeof loadV4Session>>) => {
    const saved = saveV4LocalAutosave(session);
    lastSignature.current = signatureOf(session);
    setSavedAt(saved.savedAt);
    setState('saved');
    return saved;
  };

  useEffect(() => {
    const check = () => {
      try {
        const session = loadV4Session();
        setHasSession(Boolean(session));
        if (!session) {
          const latest = loadLatestV4LocalAutosave();
          if (latest) {
            sessionStorage.setItem(PENDING_IMPORT_KEY, latest.raw);
            setRecoveryLabel(latest.identity.name ?? latest.identity.world?.name ?? 'Speculus session');
            setState('saved');
          }
          return;
        }
        setRecoveryLabel('');
        const signature = signatureOf(session);
        if (signature === lastSignature.current) return;
        persist(session);
      } catch {
        setState('fault');
      }
    };
    check();
    const timer = window.setInterval(check, 500);
    return () => window.clearInterval(timer);
  }, []);

  const saveNow = () => {
    try {
      const session = loadV4Session();
      if (!session) return;
      persist(session);
    } catch {
      setState('fault');
    }
  };

  const snapshot = () => {
    try {
      const session = loadV4Session();
      if (!session) return;
      persist(session);
      const label = window.prompt('Snapshot name (optional):', '');
      if (label === null) return;
      const raw = exportV4Session(session);
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const base = v4ExportFilename(session);
      const safe = label.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = safe ? base.replace(/\.json$/i, `_${safe}.json`) : base.replace(/\.json$/i, '_Snapshot.json');
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setState('fault');
    }
  };

  if (!hasSession && recoveryLabel) {
    return <aside className="v2-autosave-dock v2-autosave-dock--saved" aria-live="polite">
      <span>LOCAL AUTOSAVE STAGED · {recoveryLabel}</span>
    </aside>;
  }
  if (!hasSession) return null;
  const status = state === 'saved'
    ? `AUTOSAVE SAVED${savedAt ? ` ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : state === 'fault' ? 'AUTOSAVE FAULT' : 'AUTOSAVE READY';

  return <aside className={`v2-autosave-dock v2-autosave-dock--${state}`} aria-live="polite">
    <span>{status}</span>
    <button type="button" onClick={saveNow}>Save now</button>
    <button type="button" onClick={snapshot}>Download snapshot</button>
  </aside>;
}
