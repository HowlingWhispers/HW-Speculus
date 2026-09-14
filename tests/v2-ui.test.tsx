import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V2App } from '../src/v2/ui/App';
import { publicV2Package } from '../src/v2/contracts/launch';
import { createV2Session } from '../src/v2/runtime/session';
import { exportV2Session, saveV2Session } from '../src/v2/storage/session';
import { v2Package } from './v2-fixtures';

beforeEach(() => { sessionStorage.clear(); history.replaceState({}, '', '/v2'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('V2 terminal interaction', () => {
  it('does not load a V1 session during a direct V2 visit and offers raw-save recovery', async () => {
    sessionStorage.setItem('speculus.session.v1', 'existing V1 data'); render(<V2App />);
    expect(await screen.findByText('Open a simulation or load a save')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load raw save' })).toBeInTheDocument();
    expect(sessionStorage.getItem('speculus.session.v1')).toBe('existing V1 data');
    expect(screen.queryByLabelText('Your next turn')).not.toBeInTheDocument();
  });
  it('identifies and stages a raw V2 save without treating it as authorization', async () => {
    const value = createV2Session(publicV2Package(v2Package()));
    const raw = exportV2Session(value);
    const file = new File([raw], 'save.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => raw });
    render(<V2App />);
    await screen.findByText('Open a simulation or load a save');
    const input = screen.getByLabelText('Load V2 raw save');
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('Save identified')).toBeInTheDocument();
    expect(screen.getByText(/raw save is staged/i)).toBeInTheDocument();
    expect(sessionStorage.getItem('speculus.pending-import.v2')).not.toContain(value.launch.launchId);
    expect(screen.queryByLabelText('Your next turn')).not.toBeInTheDocument();
  });
  it('claims once in StrictMode and removes the launch code', async () => {
    history.replaceState({}, '', '/v2?launch=strict-mode-test');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ package: publicV2Package(v2Package()) }), { status: 200 }));
    render(<StrictMode><V2App /></StrictMode>);
    expect(await screen.findByLabelText('Your next turn')).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(location.search).toBe('');
  });
  it('persists output controls and unsent draft without writing V1 storage', async () => {
    saveV2Session(createV2Session(publicV2Package(v2Package())));
    sessionStorage.setItem('speculus.session.v1', 'unchanged'); render(<V2App />);
    await screen.findByLabelText('Your next turn');
    fireEvent.click(screen.getByRole('button', { name: /^long$/ }));
    expect(screen.getByText(/1024 output tokens/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your next turn'), { target: { value: 'An unsent draft.' } });
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('speculus.session.v2')!).draft).toBe('An unsent draft.'));
    expect(sessionStorage.getItem('speculus.session.v1')).toBe('unchanged');
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
  });
});
