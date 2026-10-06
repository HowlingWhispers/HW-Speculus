import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { V4App } from './ui/App';
import { V4DetachedTranscript } from './ui/DetachedTranscript';
import './ui/terminal.css';
import './ui/roleplay-colors.css';
import './ui/detached.css';

const displaySessionId = new URLSearchParams(window.location.search).get('display');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{displaySessionId
    ? <V4DetachedTranscript sessionId={displaySessionId} />
    : <V4App />}
  </StrictMode>,
);
