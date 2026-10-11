import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from '../src/runtime/providers/mock';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createRootBranch, generationBranchTurn, projectBranch } from '../src/v4/runtime/branches';
import { generateV4Turn } from '../src/v4/runtime/engine';
import { createV4Session } from '../src/v4/runtime/session';
import { V4DetachedTranscript } from '../src/v4/ui/DetachedTranscript';
import { SettingsPanel } from '../src/v4/ui/SettingsPanel';
import { V4Transcript } from '../src/v4/ui/Transcript';
import { v2Package } from './v2-fixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const fresh = () => {
  const launch = publicV4Package(v2Package());
  launch.character!.firstMessage = '*Authored opening remains unchanged.*';
  return createV4Session(launch);
};

describe('V4 generated reply text size display', () => {
  it('renders the saved Display value and emits integer updates immediately', () => {
    const session = fresh();
    session.settings.generatedTextFontSize = 27;
    const onSettings = vi.fn();
    const props = { session, disabled: false, onSettings, onWorld: vi.fn() };
    const { rerender } = render(<SettingsPanel {...props} />);
    const slider = screen.getByRole('slider', { name: /Generated AI reply text size/ });
    expect(slider.closest('section')).toContainElement(screen.getByRole('heading', { name: 'Display' }));
    expect(slider).toHaveAttribute('min', '14');
    expect(slider).toHaveAttribute('max', '32');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveValue('27');
    expect(screen.getByText('27px')).toBeInTheDocument();
    for (const value of [14, 32, 23]) {
      fireEvent.change(slider, { target: { value: String(value) } });
      expect(onSettings).toHaveBeenLastCalledWith({ generatedTextFontSize: value });
    }
    expect(onSettings).toHaveBeenCalledTimes(3);
    rerender(<SettingsPanel {...props} session={{ ...session, settings: { ...session.settings, generatedTextFontSize: 23 } }} />);
    expect(slider).toHaveValue('23');
    expect(screen.getByText('23px')).toBeInTheDocument();
  });

  it('resizes existing completed replies without changing turns, generating, or styling authored/player/editor text', async () => {
    const provider = new MockProvider();
    const generate = vi.spyOn(provider, 'generate');
    const initial = { ...fresh(), draft: '*Player text remains unchanged.*' };
    const branch = await generationBranchTurn(createRootBranch(initial), initial.launch, provider);
    const session = projectBranch(branch, initial.launch);
    generate.mockClear();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const props = { session, branch, busy: false, onEdit: vi.fn().mockResolvedValue(undefined) };
    const originalTurns = JSON.stringify(session.turns);
    const { container, rerender } = render(<V4Transcript {...props} />);
    const log = screen.getByRole('log', { name: 'Roleplay transcript' });
    const reply = container.querySelector('.v4-generated-prose');
    expect(reply).toHaveTextContent(session.turns[0].reply.replaceAll('*', ''));
    expect(container.querySelectorAll('.v4-generated-prose')).toHaveLength(1);
    expect(log.style.getPropertyValue('--v4-generated-text-font-size')).toBe('20px');
    fireEvent.click(screen.getByRole('button', { name: 'Edit turn 1' }));
    const editor = screen.getByRole('textbox', { name: 'Edited reply' });
    const player = screen.getByText('Player text remains unchanged.').parentElement!;
    const opening = screen.getByText('Authored opening remains unchanged.').parentElement!;
    const header = screen.getByText('Authored opening').parentElement!;
    const button = screen.getByRole('button', { name: 'Confirm edit' });
    for (const node of [player, opening, editor, header, button]) {
      expect(node.closest('.v4-generated-prose')).toBeNull();
      expect(node.style.fontSize).toBe('');
    }
    const changed = { ...session, settings: { ...session.settings, generatedTextFontSize: 32 } };
    rerender(<V4Transcript {...props} session={changed} busy />);
    expect(log.style.getPropertyValue('--v4-generated-text-font-size')).toBe('32px');
    expect(container.querySelector('.v4-generated-prose')).toBe(reply);
    expect(editor).toHaveValue(session.turns[0].reply);
    expect(screen.getByText('Generation in progress. No new state committed.').closest('.v4-generated-prose')).toBeNull();
    expect(changed.turns).toBe(session.turns);
    expect(JSON.stringify(session.turns)).toBe(originalTurns);
    expect(generate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    rerender(<V4Transcript {...props} session={changed} />);
    fireEvent.change(screen.getByLabelText('Edit scope'), { target: { value: 'input' } });
    const inputEditor = screen.getByRole('textbox', { name: 'Edited player input' });
    expect(inputEditor.closest('.v4-generated-prose')).toBeNull();
    expect(inputEditor.style.fontSize).toBe('');
  });

  it('does not mark empty-state or generation-progress copy as generated prose', () => {
    const { container } = render(<V4Transcript session={fresh()} busy />);
    expect(container.querySelector('.v4-generated-prose')).toBeNull();
    expect(screen.getByText('SIMULATION MEDIUM LOADED')).toBeInTheDocument();
    expect(screen.getByText('Generation in progress. No new state committed.')).toBeInTheDocument();
  });

  it('uses newer synchronized size settings in the detached reader without affecting player text', async () => {
    let receive: ((event: MessageEvent) => void) | null = null;
    const post = vi.fn();
    vi.stubGlobal('BroadcastChannel', class {
      postMessage = post;
      close = vi.fn();
      set onmessage(callback: (event: MessageEvent) => void) { receive = callback; }
    });
    const session = await generateV4Turn({ ...fresh(), draft: '*Detached player stays unchanged.*' }, new MockProvider());
    render(<V4DetachedTranscript sessionId="font-size-host" />);
    const send = (sequence: number, size: number) => act(() => receive?.({ data: {
      type: 'state', sessionId: 'font-size-host', branchId: 'font-size-branch', sequence,
      session: { ...session, settings: { ...session.settings, generatedTextFontSize: size } }, busy: false,
    } } as MessageEvent));
    send(1, 27);
    const log = await screen.findByRole('log');
    expect(log.style.getPropertyValue('--v4-generated-text-font-size')).toBe('27px');
    const reply = log.querySelector('.v4-generated-prose');
    const player = within(log).getByText('Detached player stays unchanged.').parentElement!;
    expect(player.closest('.v4-generated-prose')).toBeNull();
    expect(player.style.fontSize).toBe('');
    send(2, 14);
    expect(log.style.getPropertyValue('--v4-generated-text-font-size')).toBe('14px');
    expect(log.querySelector('.v4-generated-prose')).toBe(reply);
    send(1, 32);
    expect(log.style.getPropertyValue('--v4-generated-text-font-size')).toBe('14px');
    expect(post).toHaveBeenCalledWith({ type: 'ready', sessionId: 'font-size-host' });
  });

  it.each(['terminal.css', 'detached.css'])('%s keeps generated-size specificity above generic desktop and mobile prose rules', (file) => {
    const style = document.createElement('style');
    style.textContent = readFileSync(`src/v4/ui/${file}`, 'utf8');
    document.head.append(style);
    try {
      const rules: CSSStyleRule[] = [];
      // Include every media branch: mobile rules must not override the generated-only rule.
      const collect = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if ('selectorText' in rule) rules.push(rule as CSSStyleRule);
          else if ('cssRules' in rule) collect((rule as CSSMediaRule).cssRules);
        }
      };
      collect(style.sheet!.cssRules);
      const generatedSelector = file === 'terminal.css'
        ? '.spec-v2 .v2-prose.v4-generated-prose'
        : '.spec-v2.v2-detached-reader .v2-prose.v4-generated-prose';
      const generated = rules.find((rule) => rule.selectorText === generatedSelector)!;
      expect(generated).toBeDefined();
      expect(generated.style.getPropertyValue('font-size')).toBe('var(--v4-generated-text-font-size, 20px)');
      const genericSelector = generatedSelector.replace('.v4-generated-prose', '');
      const genericRules = rules.filter((rule) => rule.selectorText === genericSelector && rule.style.getPropertyValue('font-size'));
      expect(genericRules.length).toBeGreaterThan(1);
      for (const rule of genericRules) {
        expect(rule.style.getPropertyPriority('font-size')).toBe('');
        expect(generated.selectorText.match(/\.[\w-]+/g)!.length).toBeGreaterThan(rule.selectorText.match(/\.[\w-]+/g)!.length);
      }
      expect(rules.filter((rule) => rule.style.getPropertyValue('font-size').includes('--v4-generated-text-font-size'))
        .every((rule) => rule.selectorText.includes('.v4-generated-prose'))).toBe(true);
    } finally { style.remove(); }
  });
});
