import { useEffect, useRef, type CSSProperties } from 'react';
import type { V4Session } from '../runtime/session';
import { isSkippedPersonaTurn } from '../runtime/turn-control';
import type { useSpeechSynthesis } from './useSpeechSynthesis';

function RoleplayText({ text }: { text: string }) {
  return <>{text.split(/(\*[^*]+\*|\[[^\]]+\]|"[^"]+"|“[^”]+”)/g).map((part, index) =>
    part.startsWith('*') && part.endsWith('*') ? <em className="v2-action" key={index}>{part.slice(1, -1)}</em>
      : part.startsWith('[') && part.endsWith(']') ? <span className="v2-thought" key={index}>{part}</span>
        : ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith('“') && part.endsWith('”')))
          ? <span className="v2-dialogue" key={index}>{part}</span>
          : <span key={index}>{part}</span>)}</>;
}

export function V4Transcript({ session, busy, speech, onFork, canFork }: {
  session: V4Session; busy: boolean; speech?: ReturnType<typeof useSpeechSynthesis>;
  onFork?: (turnId: string) => void; canFork?: (turnId: string) => boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [session.turns, busy]);
  const subject = session.launch.character?.name ?? 'Simulation Narrator';
  const textColors = {
    '--v2-action-color': session.settings.actionColor,
    '--v2-dialogue-color': session.settings.dialogueColor,
    '--v2-thought-color': session.settings.thoughtColor,
  } as CSSProperties;
  return <div className="v2-transcript" style={textColors} ref={scroll} role="log" aria-label="Roleplay transcript" aria-live="polite" onScroll={() => {
    const node = scroll.current;
    if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
  }}>
    {session.launch.character?.firstMessage && <article className="v2-message">
      <header>{subject}<span>Authored opening</span></header>
      <div className="v2-prose"><RoleplayText text={session.launch.character.firstMessage} /></div>
    </article>}
    {!session.turns.length && <div className="v2-empty">
      <span className="v2-eyebrow">SIMULATION MEDIUM LOADED</span>
      <h2>{session.launch.primaryAsset.name}</h2>
      <p>{session.launch.scene || 'Begin with your first action or line of dialogue.'}</p>
      <small>V4 experimental foundation: V4 state authority is preserved while the new runtime is developed.</small>
    </div>}
    {session.turns.map((turn, index) => <div key={turn.id} className="v2-exchange">
      {isSkippedPersonaTurn(turn.player)
        ? <article className="v2-message v2-player v2-skipped-turn"><header>Player / {session.launch.persona.name}<span>Turn {String(index + 1).padStart(3, '0')}</span></header><div className="v2-skip-note">Persona turn skipped by operator</div></article>
        : <article className="v2-message v2-player"><header>Player / {session.launch.persona.name}<span>Turn {String(index + 1).padStart(3, '0')}</span></header><div className="v2-prose"><RoleplayText text={turn.player} /></div></article>}
      <article className="v2-message"><header>{subject}<span>State r{turn.worldRevision}</span></header><div className="v2-prose"><RoleplayText text={turn.reply} /></div>
        {onFork && <button type="button" disabled={busy || !canFork?.(turn.id)} onClick={() => onFork(turn.id)}>Fork after turn {index + 1}</button>}
        {speech && !isSkippedPersonaTurn(turn.player) && <div className="v4-speech-controls">
          <button type="button" aria-label="Speak reply" disabled={!speech.supported || !session.settings.speechEnabled || busy} onClick={() => speech.speak(turn.reply, { rate: session.settings.speechRate, voiceUri: session.settings.speechVoiceUri })}>Speak</button>
          <button type="button" aria-label="Stop speech" disabled={!speech.speaking} onClick={speech.stop}>Stop</button>
        </div>}
      </article>
    </div>)}
    {busy && <p className="v2-working">Generation in progress. No new state committed.</p>}
  </div>;
}
