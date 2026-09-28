import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V2App } from '../src/v3/ui/App';
import { publicV2Package } from '../src/v3/contracts/launch';
import { createV2Session } from '../src/v3/runtime/session';
import { saveV2Session } from '../src/v3/storage/session';
import { v2Package } from './v2-fixtures';

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); history.replaceState({}, '', '/v3');
  saveV2Session(createV2Session(publicV2Package(v2Package())));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function device(phone: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
}

describe('V3 phone controls', () => {
  it('switches screens without losing the draft and leaves Enter to insert a newline', async () => {
    device(true);
    const { container } = render(<V2App />);
    const input = await screen.findByLabelText('Your next turn');
    fireEvent.change(input, { target: { value: 'First line\nSecond line' } });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    expect(container.querySelector('.v2-layout')).toHaveAttribute('data-phone-tab', 'setup');
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    expect(container.querySelector('.v2-layout')).toHaveAttribute('data-phone-tab', 'diagnostics');
    fireEvent.click(screen.getByRole('button', { name: 'Main' }));
    expect(input).toHaveValue('First line\nSecond line');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Back to Orbis' })).toBeEnabled();
  });

  it('keeps desktop panel toggles and Enter behavior', async () => {
    device(false);
    const { container } = render(<V2App />);
    const input = await screen.findByLabelText('Your next turn');
    expect(container.querySelector('.v3-phone')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Simulation screens' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Panel visibility' })).toBeInTheDocument();
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
  });
});
