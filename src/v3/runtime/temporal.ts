import { DEFAULT_START_SECOND_OF_DAY, SECONDS_PER_DAY } from './world';

export type NarrativeDiceResult = {
  kind: 'genesys-style';
  successes: number;
  advantages: number;
  triumph: boolean;
  despair: boolean;
  summary: string;
};

export type TemporalIntent = {
  kind: 'turn' | 'explicit-duration' | 'sleep' | 'rest';
  seconds: number;
  label: string;
  check?: NarrativeDiceResult;
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

function amountOf(value: string) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return NUMBER_WORDS[value.toLowerCase()] ?? NaN;
}

function durationSeconds(text: string): number | null {
  const match = text.match(/\b(?:for|over|after)\s+(?:about\s+|roughly\s+|around\s+)?(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i);
  if (!match) return null;
  const amount = amountOf(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith('sec') ? 1 : unit.startsWith('min') ? 60 : unit.startsWith('h') ? 3600 : SECONDS_PER_DAY;
  return Math.max(1, Math.min(SECONDS_PER_DAY, Math.round(amount * multiplier)));
}

function rollSymbol(random: () => number) {
  const value = Math.max(0, Math.min(0.999999, random()));
  const face = Math.floor(value * 8);
  return {
    success: [0, 0, 1, 1, 1, 2, 0, 1][face],
    advantage: [0, 1, 0, 1, 1, 0, 2, 1][face],
  };
}

function rollNegativeSymbol(random: () => number) {
  const value = Math.max(0, Math.min(0.999999, random()));
  const face = Math.floor(value * 8);
  return {
    failure: [0, 1, 1, 0, 1, 2, 0, 1][face],
    threat: [0, 0, 1, 1, 1, 0, 2, 1][face],
  };
}

export function rollRestCheck(random: () => number = Math.random): NarrativeDiceResult {
  const positive = [rollSymbol(random), rollSymbol(random)];
  const negative = [rollNegativeSymbol(random), rollNegativeSymbol(random)];
  const successes = positive.reduce((sum, value) => sum + value.success, 0)
    - negative.reduce((sum, value) => sum + value.failure, 0);
  const advantages = positive.reduce((sum, value) => sum + value.advantage, 0)
    - negative.reduce((sum, value) => sum + value.threat, 0);
  const rare = Math.max(0, Math.min(0.999999, random()));
  const triumph = rare >= 0.985;
  const despair = rare < 0.015;
  const quality = successes > 0 ? 'restful' : successes < 0 ? 'restless' : 'mixed';
  const side = advantages > 0 ? ' with a favorable side effect' : advantages < 0 ? ' with a complication opportunity' : '';
  return {
    kind: 'genesys-style', successes, advantages, triumph, despair,
    summary: `${quality} rest${side}${triumph ? '; triumph opportunity' : ''}${despair ? '; despair opportunity' : ''}`,
  };
}

function secondsUntilMorning(currentTimeOfDaySeconds: number) {
  const morning = 7 * 3600;
  if (currentTimeOfDaySeconds < morning) return morning - currentTimeOfDaySeconds;
  return SECONDS_PER_DAY - currentTimeOfDaySeconds + morning;
}

export function resolveTemporalIntent(
  player: string,
  random: () => number = Math.random,
  currentTimeOfDaySeconds = DEFAULT_START_SECOND_OF_DAY,
): TemporalIntent {
  const text = player.trim();
  const explicit = durationSeconds(text);
  const nap = /\b(?:nap(?:ped|ping)?|doz(?:e|ed|ing))\b/i.test(text);
  const sleep = /\b(?:sleep|slept|asleep|nap(?:ped|ping)?|doz(?:e|ed|ing)|drift(?:ed|ing)?\s+off)\b/i.test(text)
    || /\b(?:go|went|going|head|headed|heading|climb|climbed|climbing)\s+(?:to|into)\s+(?:my|their|his|her|the)?\s*bed\b/i.test(text)
    || /closed\s+(?:my|their|his|her)\s+eyes[^.!?]{0,80}(?:sleep|drift)/i.test(text);

  if (sleep) {
    const untilMorning = /\b(?:until|till)\s+(?:the\s+)?(?:morning|dawn|sunrise)\b/i.test(text)
      || /\bsleep\s+through\s+the\s+night\b/i.test(text);
    const seconds = explicit ?? (untilMorning ? secondsUntilMorning(currentTimeOfDaySeconds) : nap ? 3600 : 8 * 3600);
    return {
      kind: 'sleep', seconds,
      label: explicit ? `sleep:${seconds}s` : untilMorning ? `sleep:until-morning:${seconds}s` : `sleep:inferred:${seconds}s`,
      check: rollRestCheck(random),
    };
  }
  if (explicit) return { kind: 'explicit-duration', seconds: explicit, label: `elapsed:${explicit}s` };
  if (/\b(?:wait(?:ed|ing)?|rest(?:ed|ing)?|sat|sit|linger(?:ed|ing)?)\b[^.!?]{0,80}\bfor\s+(?:a|some)\s+while\b/i.test(text)) {
    return { kind: 'rest', seconds: 15 * 60, label: 'elapsed:inferred-rest:900s' };
  }

  return { kind: 'turn', seconds: 30, label: 'elapsed:turn:30s' };
}
