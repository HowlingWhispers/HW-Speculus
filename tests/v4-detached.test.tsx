import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { V4DetachedTranscript } from '../src/v4/ui/DetachedTranscript';
import { createV4Session } from '../src/v4/runtime/session';
import { publicV4Package } from '../src/v4/contracts/launch';
import { generateV4Turn } from '../src/v4/runtime/engine';
import { MockProvider } from '../src/runtime/providers/mock';
import { v2Package } from './v2-fixtures';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps a detached reader on the newest branch envelope and never autoplays history', async () => {
  let receive: ((event: MessageEvent) => void) | null = null;
  const post = vi.fn();
  vi.stubGlobal('BroadcastChannel', class {
    postMessage = post;
    close = vi.fn();
    set onmessage(callback: (event: MessageEvent) => void) { receive = callback; }
  });
  const speak = vi.fn();
  vi.stubGlobal('speechSynthesis', { speak });
  const original = await generateV4Turn({ ...createV4Session(publicV4Package(v2Package())), draft: 'Hello' }, new MockProvider());
  const display = (reply: string) => ({ ...original, settings: { ...original.settings, speechEnabled: true }, turns: [{ ...original.turns[0], reply }] });
  render(<V4DetachedTranscript sessionId="host-connection" />);
  const send = (sequence: number, branchId: string, reply: string) => act(() => receive?.({ data: {
    type: 'state', sessionId: 'host-connection', sequence, branchId, session: display(reply), busy: false,
  } } as MessageEvent));
  send(1, 'branch-a', '*First branch reply.*');
  expect(await screen.findByText('First branch reply.')).toBeInTheDocument();
  send(2, 'branch-b', '*Second branch reply.*');
  expect(await screen.findByText('Second branch reply.')).toBeInTheDocument();
  send(1, 'branch-a', '*First branch reply.*');
  expect(screen.queryByText('First branch reply.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Speak reply' })).toBeNull();
  expect(speak).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith({ type: 'ready', sessionId: 'host-connection' });
});
