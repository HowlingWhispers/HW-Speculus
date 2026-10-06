import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { V4Session } from '../runtime/session';
import { isSkippedPersonaTurn } from '../runtime/turn-control';
import type { useSpeechSynthesis } from './useSpeechSynthesis';
import type { V4Branch } from '../runtime/branches';

function RoleplayText({ text }: { text: string }) {
  return <>{text.split(/(\*[^*]+\*|\[[^\]]+\]|"[^"]+"|“[^”]+”)/g).map((part, index) =>
    part.startsWith('*') && part.endsWith('*') ? <em className="v2-action" key={index}>{part.slice(1, -1)}</em>
      : part.startsWith('[') && part.endsWith(']') ? <span className="v2-thought" key={index}>{part}</span>
        : ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith('“') && part.endsWith('”')))
          ? <span className="v2-dialogue" key={index}>{part}</span>
          : <span key={index}>{part}</span>)}</>;
}

export function V4Transcript({ session, busy, speech, onFork, canFork, branch, previews = {}, onPreview, onAlternative, onContinue, onEdit }: {
  session: V4Session; busy: boolean; speech?: ReturnType<typeof useSpeechSynthesis>;
  onFork?: (turnId: string, pageId?: string) => void; canFork?: (turnId: string) => boolean;
  branch?: V4Branch; previews?: Record<string, string>;
  onPreview?: (turnId: string, pageId: string) => void;
  onAlternative?: (turnId: string) => void; onContinue?: (turnId: string, pageId: string) => void;
  onEdit?: (turnId: string, changes: { player?: string; reply?: string }) => Promise<void>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [editor, setEditor] = useState<{ turnId: string; player: string; reply: string; scope: 'reply' | 'input' } | null>(null);
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
    {session.turns.map((turn, index) => {
      const canonical = branch?.turns.find((value) => value.id === turn.id);
      const pageId = previews[turn.id] ?? canonical?.activePageId;
      const pageIndex = canonical?.pages.findIndex((page) => page.id === pageId) ?? -1;
      const page = canonical?.pages[pageIndex];
      const reply = page?.reply ?? turn.reply;
      const player = page?.player ?? turn.player;
      const verified = Boolean(page?.before && page?.resolved && page?.after && page?.resolution);
      const preview = Boolean(canonical && pageId !== canonical.activePageId);
      return <div key={turn.id} className="v2-exchange">
      {isSkippedPersonaTurn(player)
        ? <article className="v2-message v2-player v2-skipped-turn"><header>Player / {session.launch.persona.name}<span>Turn {String(index + 1).padStart(3, '0')}</span></header><div className="v2-skip-note">Persona turn skipped by operator</div></article>
        : <article className="v2-message v2-player"><header>Player / {session.launch.persona.name}<span>Turn {String(index + 1).padStart(3, '0')}</span></header><div className="v2-prose"><RoleplayText text={player} /></div></article>}
      <article className="v2-message"><header>{subject}<span>State r{page?.worldRevision ?? turn.worldRevision}</span></header><div className="v2-prose"><RoleplayText text={reply} /></div>
        {canonical && <div className="v4-page-controls" role="group" aria-label={`Turn ${index + 1} pages`}>
          <button type="button" aria-label={`Previous page for turn ${index + 1}`} disabled={busy || pageIndex <= 0} onClick={() => onPreview?.(turn.id, canonical.pages[pageIndex - 1].id)}>Previous</button>
          <span>Page {pageIndex + 1} / {canonical.pages.length} / {preview ? 'Preview only' : 'Active'}</span>
          <button type="button" aria-label={`Next page for turn ${index + 1}`} disabled={busy || pageIndex >= canonical.pages.length - 1} onClick={() => onPreview?.(turn.id, canonical.pages[pageIndex + 1].id)}>Next</button>
          <button type="button" disabled={busy || !verified || session.launch.expiresAt <= Date.now()} onClick={() => onAlternative?.(turn.id)}>Generate alternative for turn {index + 1}</button>
          <button type="button" disabled={busy || !verified || (!preview && index === session.turns.length - 1)} onClick={() => onContinue?.(turn.id, page!.id)}>Continue from this page</button>
          {onEdit && <button type="button" disabled={busy || !verified || preview} onClick={() => setEditor({ turnId: turn.id, player: isSkippedPersonaTurn(player) ? '' : player, reply, scope: 'reply' })}>Edit turn {index + 1}</button>}
        </div>}
        {onFork && <button type="button" disabled={busy || (canonical ? !verified : !canFork?.(turn.id))} onClick={() => onFork(turn.id, page?.id)}>Fork after turn {index + 1}</button>}
        {speech && !isSkippedPersonaTurn(player) && <div className="v4-speech-controls">
          <button type="button" aria-label="Speak reply" disabled={!speech.supported || !session.settings.speechEnabled || busy} onClick={() => speech.speak(reply, { rate: session.settings.speechRate, voiceUri: session.settings.speechVoiceUri })}>Speak</button>
          <button type="button" aria-label="Stop speech" disabled={!speech.speaking} onClick={speech.stop}>Stop</button>
        </div>}
      </article>
    </div>;
    })}
    {editor && <section className="v2-instrument v4-history-editor" role="dialog" aria-modal="false" aria-label="Edit historical turn">
      <h3>Edit turn</h3>
      <p>Previous pages and parent futures remain saved. Changing input resolves and generates anew; reply edits do not author physical state.</p>
      <label className="v2-field"><span>Edit scope</span><select aria-label="Edit scope" value={editor.scope} disabled={busy} onChange={(event) => setEditor({ ...editor, scope: event.target.value as 'reply' | 'input' })}>
        <option value="reply">Reply only / retain trusted resolution</option><option value="input" disabled={session.launch.expiresAt <= Date.now()}>Player input / resolve and generate anew</option>
      </select></label>
      {editor.scope === 'input' ? <label className="v2-field"><span>Edited player input</span><textarea aria-label="Edited player input" maxLength={16000} value={editor.player} disabled={busy} onChange={(event) => setEditor({ ...editor, player: event.target.value })} /></label>
        : <label className="v2-field"><span>Edited reply</span><textarea aria-label="Edited reply" maxLength={64000} value={editor.reply} disabled={busy} onChange={(event) => setEditor({ ...editor, reply: event.target.value })} /></label>}
      <button type="button" disabled={busy || !(editor.scope === 'input' ? editor.player.trim() : editor.reply.trim())} onClick={() => {
        void onEdit?.(editor.turnId, editor.scope === 'input' ? { player: editor.player } : { reply: editor.reply }).then(() => setEditor(null)).catch(() => undefined);
      }}>Confirm edit</button>
      <button type="button" disabled={busy} onClick={() => setEditor(null)}>Cancel edit</button>
    </section>}
    {busy && <p className="v2-working">Generation in progress. No new state committed.</p>}
  </div>;
}
