import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { V2AutosaveControls } from './ui/AutosaveControls';
import { V2App } from './ui/App';
import { V2DetachedTranscript } from './ui/DetachedTranscript';
import './ui/terminal.css';
import './ui/roleplay-colors.css';
import './ui/detached.css';

const displaySessionId = new URLSearchParams(window.location.search).get('display');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{displaySessionId
    ? <V2DetachedTranscript sessionId={displaySessionId} />
    : <><V2App /><V2AutosaveControls /></>}
  </StrictMode>,
);
