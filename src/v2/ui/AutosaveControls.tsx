import { useEffect, useRef, useState } from 'react';
import { saveV2LocalAutosave } from '../storage/autosave';
import { exportV2Session, loadV2Session, v2ExportFilename } from '../storage/session';
import './autosave.css';

type SaveState = 'standby' | 'saved' | 'fault';

function signatureOf(session: NonNullable<ReturnType<typeof loadV2Session>>) {
  const last = session.turns.at(-1);
  return [session.id, session.world.revision, session.turns.length, last?.id ?? '', last?.reply ?? ''].join('|');
}

export function V2AutosaveControls() {
  const [state, setState] = useState<SaveState>('standby');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const lastSignature = useRef('');

  useEffect(() => {
    const check = () => {
      try {
        const session = loadV2Session();
        setHasSession(Boolean(session));
        if (!session || session.turns.length === 0) return;
        const signature = signatureOf(session);
        if (signature === lastSignature.current) return;
        lastSignature.current = signature;
        const saved = saveV2LocalAutosave(session);
        setSavedAt(saved.savedAt);
        setState('saved');
      } catch {
        setState('fault');
      }
    };
    check();
    const timer = window.setInterval(check, 500);
    return () => window.clearInterval(timer);
  }, []);

  const snapshot = () => {
    try {
      const session = loadV2Session();
      if (!session) return;
      const label = window.prompt('Snapshot name (optional):', '');
      if (label === null) return;
      const raw = exportV2Session(session);
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const base = v2ExportFilename(session);
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

  if (!hasSession) return null;
  const status = state === 'saved'
    ? `AUTOSAVE SAVED${savedAt ? ` ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : state === 'fault' ? 'AUTOSAVE FAULT' : 'AUTOSAVE READY';

  return <aside className={`v2-autosave-dock v2-autosave-dock--${state}`} aria-live="polite">
    <span>{status}</span>
    <button type="button" onClick={snapshot}>Save snapshot</button>
  </aside>;
}
