import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V4App as AppComponent } from '../src/v4/ui/App';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createV4Session } from '../src/v4/runtime/session';
import { saveV4Session } from '../src/v4/storage/session';
import { loadV4Authorization } from '../src/v4/storage/authorization';
import { openSideReader } from '../src/v4/ui/reader-window';
import { v2Package } from './v2-fixtures';
import { IndexedDBDouble } from './v4-indexeddb-fixture';

let V4App: typeof AppComponent;
beforeEach(async () => {
  vi.resetModules();
  sessionStorage.clear(); localStorage.clear(); history.replaceState({}, '', '/v4');
  vi.stubGlobal('indexedDB', new IndexedDBDouble().factory);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  ({ V4App } = await import('../src/v4/ui/App'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('V4 baseline UI', () => {
  it('boots standalone without reading legacy state or making authorization requests', async () => {
    sessionStorage.setItem('speculus.session.v3.experimental', 'do-not-read');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<V4App />);
    expect(await screen.findByText('V4 / BOOT SEQUENCE')).toBeInTheDocument();
    expect(document.title).toBe('Speculus V4 | Simulation Laboratory');
    expect(screen.queryByLabelText('Your next turn')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('claims a compatible fresh launch using only the V4 client bridge', async () => {
    history.replaceState({}, '', '/v4?launch=v4-baseline-code');
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ package: publicV4Package(v2Package()) }) });
    vi.stubGlobal('fetch', fetch);
    render(<V4App />);
    expect(await screen.findByLabelText('Your next turn')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/v4/launch/v4-baseline-code', { credentials: 'same-origin', cache: 'no-store' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(loadV4Authorization()?.primaryAsset).toEqual(publicV4Package(v2Package()).primaryAsset);
    expect(window.location.search).toBe('');
  });

  it('retains inherited mobile screens and draft state', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    saveV4Session(createV4Session(publicV4Package(v2Package())));
    const { container } = render(<V4App />);
    const input = await screen.findByLabelText('Your next turn');
    fireEvent.change(input, { target: { value: 'First line\nSecond line' } });
    await waitFor(() => expect(input).toHaveValue('First line\nSecond line'));
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    expect(container.querySelector('.v2-layout')).toHaveAttribute('data-phone-tab', 'setup');
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    expect(container.querySelector('.v2-layout')).toHaveAttribute('data-phone-tab', 'diagnostics');
    fireEvent.click(screen.getByRole('button', { name: 'Main' }));
    expect(input).toHaveValue('First line\nSecond line');
  });

  it('opens an isolated detached reader without carrying launch authorization', () => {
    history.replaceState({}, '', '/v4?launch=secret#fragment');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openSideReader('session-id', 'speculus-v4-display');
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/v4?display=session-id`, 'speculus-v4-display-session-id', expect.any(String));
  });
});
