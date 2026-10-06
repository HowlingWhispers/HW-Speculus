import { useCallback, useEffect, useRef, useState } from 'react';

export function speechText(text: string): string {
  return text.replace(/[\*\[\]"“”]/g, '').replace(/\s+/g, ' ').trim();
}

export function useSpeechSynthesis() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const current = useRef<SpeechSynthesisUtterance | null>(null);

  const stop = useCallback(() => {
    const utterance = current.current;
    current.current = null;
    if (utterance) {
      utterance.onend = null;
      utterance.onerror = null;
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }, []);

  useEffect(() => {
    if (!supported) return;
    const synthesis = window.speechSynthesis;
    const refresh = () => setVoices(synthesis.getVoices());
    refresh();
    synthesis.addEventListener('voiceschanged', refresh);
    return () => {
      synthesis.removeEventListener('voiceschanged', refresh);
      const utterance = current.current;
      current.current = null;
      if (utterance) {
        utterance.onend = null;
        utterance.onerror = null;
        synthesis.cancel();
      }
    };
  }, [supported]);

  const speak = useCallback((text: string, options: { rate?: number; voiceUri?: string } = {}) => {
    if (!supported) return;
    const prose = speechText(text);
    if (!prose) return;
    stop();
    // The browser queue is global, including speech started outside this hook.
    window.speechSynthesis.cancel();
    const utterance = new window.SpeechSynthesisUtterance(prose);
    utterance.rate = Number.isFinite(options.rate) ? Math.max(0.5, Math.min(2, options.rate!)) : 1;
    utterance.voice = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === options.voiceUri) ?? null;
    current.current = utterance;
    const finish = () => {
      if (current.current !== utterance) return;
      current.current = null;
      setSpeaking(false);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    setSpeaking(true);
    try { window.speechSynthesis.speak(utterance); }
    catch { finish(); }
  }, [supported, stop]);

  return { supported, voices, speaking, speak, stop };
}
