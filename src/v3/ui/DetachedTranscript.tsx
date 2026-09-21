import { useEffect, useState } from 'react';
import type { V2Session } from '../runtime/session';
import { detachedTranscriptChannelName, type DetachedTranscriptMessage } from './detached-channel';
import { V2Transcript } from './Transcript';

export function V2DetachedTranscript({ sessionId, hostWindow = window, hostDocument = document }: { sessionId: string; hostWindow?: Window; hostDocument?: Document }) {
  const [session, setSession] = useState<V2Session | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof BroadcastChannel !== 'undefined';

  useEffect(() => {
    hostDocument.title = 'Speculus V3 | Detached Reader';
    if (!supported) return;
    const channel = new BroadcastChannel(detachedTranscriptChannelName(sessionId));
    const announceReady = () => channel.postMessage({ type: 'ready', sessionId } satisfies DetachedTranscriptMessage);
    channel.onmessage = (event: MessageEvent<DetachedTranscriptMessage>) => {
      const message = event.data;
      if (!message || message.sessionId !== sessionId) return;
      if (message.type === 'probe') {
        announceReady();
        return;
      }
      if (message.type === 'state') {
        setSession(message.session);
        setBusy(message.busy);
      }
    };
    announceReady();
    const announceClosed = () => channel.postMessage({ type: 'closed', sessionId } satisfies DetachedTranscriptMessage);
    hostWindow.addEventListener('beforeunload', announceClosed);
    return () => {
      hostWindow.removeEventListener('beforeunload', announceClosed);
      channel.close();
    };
  }, [sessionId, supported, hostWindow, hostDocument]);

  return <main className={`spec-v2 v2-detached-reader ${session?.settings.crtEffects !== false ? 'v2-crt' : ''}`}>
    <header className="v2-masthead v2-reader-masthead">
      <div><div className="v2-brand"><h1>SPECULUS</h1><span>V3</span><span className="v2-badge">Detached reader</span></div><p>Live world render / read only</p></div>
      <div className="v2-connection"><span>{session ? 'LIVE LINK' : 'WAITING'}</span><small>{session ? session.launch.primaryAsset.name : supported ? 'Waiting for the main Speculus window' : 'BroadcastChannel is not supported in this browser'}</small></div>
    </header>
    <section className="v2-panel v2-reader-panel" aria-label="Detached roleplay transcript">
      {session
        ? <V2Transcript session={session} busy={busy} />
        : <div className="v2-reader-wait"><span className="v2-eyebrow">DETACHED DISPLAY</span><h2>{supported ? 'Waiting for live transcript...' : 'Detached reader unavailable'}</h2><p>{supported ? 'Keep the main Speculus V3 window open. This reader will synchronize automatically.' : 'Use a browser with BroadcastChannel support or keep the transcript in the main Speculus window.'}</p></div>}
    </section>
    <footer className="v2-status" aria-live="polite"><div><span className={session ? 'is-complete' : 'is-active'}><i />{session ? 'linked' : 'waiting'}</span><span className={busy ? 'is-active' : ''}><i />{busy ? 'generation active' : 'reader ready'}</span></div><span>READ ONLY</span><small>/v3/display</small></footer>
  </main>;
}
