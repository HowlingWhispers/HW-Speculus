import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V4Transcript } from '../src/v4/ui/Transcript';
import { SettingsPanel } from '../src/v4/ui/SettingsPanel';
import { createV4Session } from '../src/v4/runtime/session';
import { publicV4Package } from '../src/v4/contracts/launch';
import { generateV4Turn } from '../src/v4/runtime/engine';
import { exportV4Session, importV4Session, saveV4Session } from '../src/v4/storage/session';
import { V4App } from '../src/v4/ui/App';
import { MockProvider } from '../src/runtime/providers/mock';
import { v2Package } from './v2-fixtures';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });
async function session(skipPersona = false) {
  return generateV4Turn({ ...createV4Session(publicV4Package(v2Package())), draft: 'Hello.' }, new MockProvider(), { skipPersona });
}
describe('V4 speech controls', () => {
  it('reads only a newly committed reply, stops on disable, and suppresses skipped turns', async () => {
    sessionStorage.clear(); localStorage.clear(); history.replaceState({}, '', '/v4');
    const base = await session();
    saveV4Session({ ...base, settings: { ...base.settings, speechEnabled: true } });
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel, getVoices: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: '*She smiles.* "Welcome."', metadata: { provider: 'orbis', model: 'mock', durationMs: 1, completionStatus: 'stop' } }), { status: 200 })));
    render(<V4App />);
    const input = await screen.findByLabelText('Your next turn');
    expect(speak).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Hello again.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Welcome.', { exact: false });
    expect(speak).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read new replies aloud' }));
    expect(cancel).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read new replies aloud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip as' }));
    fireEvent.click(screen.getByRole('button', { name: 'Narrator / automatic' }));
    await screen.findByText('Persona turn skipped by operator');
    expect(speak).toHaveBeenCalledTimes(1);
  });
  it('requires opt-in and preserves voice/rate in raw saves', async () => {
    const base = await session();
    expect(base.settings.speechEnabled).toBe(false);
    const enabled = { ...base, settings: { ...base.settings, speechEnabled: true, speechRate: 1.5, speechVoiceUri: 'selected' } };
    expect(importV4Session(exportV4Session(enabled), base).settings).toMatchObject({ speechEnabled: true, speechRate: 1.5, speechVoiceUri: 'selected' });
  });
  it('exposes manual speech only for eligible replies and never autoplays history', async () => {
    const base = await session();
    const speak = vi.fn();
    const speech = { supported: true, voices: [], speaking: false, speak, stop: vi.fn() };
    const view = render(<V4Transcript session={{ ...base, settings: { ...base.settings, speechEnabled: true } }} busy={false} speech={speech} />);
    expect(speak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Speak reply' }));
    expect(speak).toHaveBeenCalledWith(base.turns[0].reply, { rate: 1, voiceUri: undefined });
    view.rerender(<V4Transcript session={await session(true)} busy={false} speech={speech} />);
    expect(screen.queryByRole('button', { name: 'Speak reply' })).toBeNull();
  });
  it('disables unavailable speech controls', async () => {
    const base = await session();
    const speech = { supported: false, voices: [], speaking: false, speak: vi.fn(), stop: vi.fn() };
    render(<SettingsPanel session={base} disabled={false} onSettings={vi.fn()} onWorld={vi.fn()} speech={speech} />);
    expect(screen.getByRole('checkbox', { name: 'Read new replies aloud' })).toBeDisabled();
    expect(screen.getByLabelText('Speech rate')).toBeDisabled();
  });
});
