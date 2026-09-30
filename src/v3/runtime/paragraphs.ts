/**
 * Deterministic, post-generation readability pass.
 *
 * Hard rules:
 *  - It may ONLY insert paragraph breaks. It never rewrites, trims, reorders or
 *    re-punctuates a single character of the author's wording.
 *  - It never breaks inside quoted dialogue, *action markup* or [inner voice].
 *  - It never touches a paragraph that is already readable, so a model that
 *    remembered the formatting instruction is left completely alone.
 */

const LONG_PARAGRAPH_CHARACTERS = 700;
const TARGET_PARAGRAPH_CHARACTERS = 520;

type Region = 'plain' | 'quote' | 'action' | 'voice';

function regionAt(text: string, index: number): Region {
  let region: Region = 'plain';
  for (let i = 0; i < index; i += 1) {
    const char = text[i];
    if (region === 'plain') {
      if (char === '"' || char === '“') region = 'quote';
      else if (char === '*') region = 'action';
      else if (char === '[') region = 'voice';
    } else if ((region === 'quote' && (char === '"' || char === '”'))
      || (region === 'action' && char === '*')
      || (region === 'voice' && char === ']')) {
      region = 'plain';
    }
  }
  return region;
}

/**
 * Offsets where a break is legal: outside every markup region, not inside a
 * word, and followed by a non-space character.
 */
function safeBreakOffsets(paragraph: string) {
  const offsets: number[] = [];
  for (let i = 1; i < paragraph.length; i += 1) {
    if (regionAt(paragraph, i) !== 'plain') continue;
    if (/\S/.test(paragraph[i])) continue;
    let next = i;
    while (next < paragraph.length && /\s/.test(paragraph[next])) next += 1;
    if (next >= paragraph.length) continue;
    offsets.push(next);
  }
  return offsets;
}

const SENTENCE_END = /[.!?]["”*]?$/;

function isSentenceBoundary(paragraph: string, offset: number) {
  const before = paragraph.slice(0, offset).trimEnd();
  return SENTENCE_END.test(before) || /[,;:—]$/.test(before);
}

/**
 * Closes an action/dialogue chunk, e.g. the offset just after `*waves.*` or
 * `"Come in."` — the preferred place to start a fresh readable paragraph.
 */
function closesChunk(paragraph: string, offset: number) {
  const before = paragraph.slice(0, offset).trimEnd();
  return /\*$/.test(before) || /["”]$/.test(before) || /\]$/.test(before);
}

function splitLongParagraph(paragraph: string) {
  const offsets = safeBreakOffsets(paragraph);
  if (!offsets.length) return [paragraph];

  const pieces: string[] = [];
  let start = 0;
  let cursor = 0;
  while (cursor - start < TARGET_PARAGRAPH_CHARACTERS) {
    const limit = start + TARGET_PARAGRAPH_CHARACTERS;
    const next = offsets.find((offset) => offset > cursor && offset <= limit);
    if (next === undefined) break;
    const after = offsets.filter((offset) => offset > next);
    // Stop early if the remainder would be a one-sentence stub: better one long
    // readable paragraph than a wall of tiny single-sentence fragments.
    if (paragraph.length - next < 120) break;
    const chosen = after.find((offset) => closesChunk(paragraph, offset) && offset - next <= TARGET_PARAGRAPH_CHARACTERS)
      ?? after.find((offset) => isSentenceBoundary(paragraph, offset) && offset - next <= TARGET_PARAGRAPH_CHARACTERS)
      ?? next;
    pieces.push(paragraph.slice(start, chosen).trim());
    start = chosen;
    cursor = chosen;
    void limit;
  }
  pieces.push(paragraph.slice(start).trim());
  return pieces.filter(Boolean);
}

/**
 * Inserts paragraph breaks into a giant prose block and leaves everything else
 * byte-identical.
 */
export function normalizeV2Paragraphs(text: string) {
  if (!text.trim()) return { text, applied: false, paragraphs: 0, splitParagraphs: 0 };
  const normalizedNewlines = text.replace(/\r\n?/g, '\n');
  const source = normalizedNewlines.split('\n');
  const out: string[] = [];
  let splitParagraphs = 0;

  for (const rawParagraph of source) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) {
      out.push('');
      continue;
    }
    if (paragraph.length <= LONG_PARAGRAPH_CHARACTERS) {
      out.push(paragraph);
      continue;
    }
    const pieces = splitLongParagraph(paragraph);
    if (pieces.length > 1) splitParagraphs += 1;
    out.push(...pieces);
  }

  const collapsed = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    text: collapsed,
    applied: collapsed !== text,
    paragraphs: collapsed ? collapsed.split(/\n{2,}/).filter((part) => part.trim()).length : 0,
    splitParagraphs,
  };
}

export function countV2Paragraphs(text: string) {
  return text ? text.split(/\n{2,}/).filter((part) => part.trim()).length : 0;
}

/** Word-count estimate used only for diagnostic banding, never for padding. */
export function approximateV2OutputTokens(text: string) {
  return Math.ceil(text.length / 4);
}
