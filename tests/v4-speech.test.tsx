import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { speechText, useSpeechSynthesis } from '../src/v4/ui/useSpeechSynthesis';

class Utterance {
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}
function browser() {
  const events = new EventTarget();
  let voices: SpeechSynthesisVoice[] = [];
  const synthesis = {
    getVoices: () => voices,
    cancel: vi.fn(), speak: vi.fn(),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  vi.stubGlobal('speechSynthesis', synthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  return { synthesis, change: (next: SpeechSynthesisVoice[]) => {
    voices = next;
    events.dispatchEvent(new Event('voiceschanged'));
  } };
}
afterEach(() => vi.unstubAllGlobals());

describe('V4 browser speech', () => {
  it('is unsupported without the browser API and never speaks on mount', () => {
    const hook = renderHook(useSpeechSynthesis);
    expect(hook.result.current.supported).toBe(false);
    act(() => hook.result.current.speak('Hello'));
    expect(hook.result.current.speaking).toBe(false);
  });
  it('loads delayed voices, uses URI/rate, replaces speech and ignores stale callbacks', () => {
    const api = browser();
    const hook = renderHook(useSpeechSynthesis);
    expect(api.synthesis.speak).not.toHaveBeenCalled();
    expect(hook.result.current.voices).toEqual([]);
    const voice = { voiceURI: 'test-uri', name: 'Test' } as SpeechSynthesisVoice;
    act(() => api.change([voice]));
    expect(hook.result.current.voices).toEqual([voice]);
    act(() => hook.result.current.speak('*Hello.* "Welcome."', { rate: 1.5, voiceUri: 'test-uri' }));
    const first = api.synthesis.speak.mock.calls[0][0] as Utterance;
    const stale = first.onend;
    expect(first.text).toBe('Hello. Welcome.');
    expect(first.rate).toBe(1.5);
    expect(first.voice).toBe(voice);
    act(() => hook.result.current.speak('Replacement', { rate: 5, voiceUri: 'missing' }));
    const second = api.synthesis.speak.mock.calls[1][0] as Utterance;
    expect(second.rate).toBe(2);
    expect(second.voice).toBeNull();
    act(() => stale?.());
    expect(hook.result.current.speaking).toBe(true);
    act(() => second.onerror?.());
    expect(hook.result.current.speaking).toBe(false);
  });
  it('stops and cleans up owned speech on unmount', () => {
    const api = browser();
    const hook = renderHook(useSpeechSynthesis);
    act(() => hook.result.current.speak('Hello'));
    act(() => hook.result.current.stop());
    expect(hook.result.current.speaking).toBe(false);
    act(() => hook.result.current.speak('Again'));
    const current = api.synthesis.speak.mock.calls[1][0] as Utterance;
    hook.unmount();
    expect(current.onend).toBeNull();
    expect(api.synthesis.cancel).toHaveBeenCalled();
  });
  it('strips delimiters without changing the source prose', () => {
    expect(speechText('*Wait.* [Think.] "Speak."')).toBe('Wait. Think. Speak.');
  });
});
