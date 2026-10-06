export type V4ProseSlopHit = { id: string; label: string; matched: string };

// Independently authored structural checks inspired by the general idea of
// local prose linting. Keep this deliberately narrow: vocabulary preferences
// belong in guidance, while automatic repair requires repeated structure.
const rules: Array<{ id: string; label: string; pattern: RegExp }> = [
  {
    id: 'trailing-perception-appositive',
    label: 'trailing perception appositive',
    pattern: /,\s+(?:her|his|their|its)\s+(?:voice|gaze|expression|smile|presence)\s+(?:a|an)\s+[^,.!?]{2,60}(?=[.!?]|$)/i,
  },
  {
    id: 'contrast-reframe',
    label: 'formulaic contrast reframe',
    pattern: /\b(?:it|this|that)\s+(?:was|is)(?:n't|\s+not)\b[^.!?;]{1,80}[;,.]\s*(?:it|this|that)\s+(?:was|is)\b/i,
  },
  {
    id: 'stacked-fragments',
    label: 'stacked emphatic fragments',
    pattern: /(?:^|[.!?]\s+)(?:Not|No)\s+[^.!?]{1,45}[.!?]\s+(?:Not|No)\s+[^.!?]{1,45}[.!?]\s+(?:Just|Only)\s+[^.!?]{1,45}[.!?]/i,
  },
];

const normalizedWords = (text: string) => text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}']+/gu) ?? [];

function repeatedPhraseHit(text: string): V4ProseSlopHit | undefined {
  const words = normalizedWords(text);
  for (let size = 7; size >= 4; size -= 1) {
    const counts = new Map<string, number>();
    for (let index = 0; index <= words.length - size; index += 1) {
      const phrase = words.slice(index, index + size).join(' ');
      const count = (counts.get(phrase) ?? 0) + 1;
      if (count >= 3) return { id: 'repeated-phrase', label: 'repeated multiword phrase', matched: phrase };
      counts.set(phrase, count);
    }
  }
  return undefined;
}

export function detectV4ProseSlop(text: string): V4ProseSlopHit[] {
  const hits: V4ProseSlopHit[] = [];
  for (const rule of rules) {
    const match = rule.pattern.exec(text);
    if (match?.[0]) hits.push({ id: rule.id, label: rule.label, matched: match[0] });
  }
  const repeated = repeatedPhraseHit(text);
  if (repeated) hits.push(repeated);
  return hits;
}

export function needsV4ProseRepair(hits: V4ProseSlopHit[]) {
  const ids = new Set(hits.map((hit) => hit.id));
  return ids.has('repeated-phrase') || ids.size >= 2;
}

export const V4_ANTI_SLOP_GUIDANCE = [
  'Avoid stock voice textures, sensation clichés, and formulaic contrast frames. Use concrete actions and dialogue. If a phrase just appeared nearby, change the action instead.',
];

export function v4ProseRepairPrompt(input: {
  originalPrompt: string;
  draft: string;
  targetTokens: number;
  hardLimitTokens: number;
  truncated: boolean;
  hits: V4ProseSlopHit[];
}) {
  const reasons = [
    input.truncated ? 'The previous draft reached the hard ceiling before completing its current beat.' : '',
    input.hits.length ? `It also used these stock constructions: ${input.hits.map((hit) => hit.label).join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  return [
    input.originalPrompt,
    '',
    '[ONE BOUNDED PROSE REPAIR]',
    reasons,
    `Rewrite the complete visible turn to finish naturally within ${input.targetTokens} tokens. The emergency hard ceiling is ${input.hardLimitTokens} tokens.`,
    'Preserve the same events, actions, dialogue intent, names, viewpoint, tense, scene state and outcome. Do not continue beyond the current playable beat.',
    'Remove the flagged constructions instead of replacing them with synonyms or another stock phrase.',
    'Return only the complete repaired in-world response. Close every quote, action delimiter and inner-voice bracket before stopping.',
    '',
    'PREVIOUS DRAFT:',
    input.draft,
  ].join('\n');
}
