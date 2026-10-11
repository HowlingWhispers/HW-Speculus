export const V4_ROLEPLAY_FORMAT_CONTRACT = [
  'SPECULUS V4 ROLEPLAY FORMAT CONTRACT',
  'Every visible prose span must use one roleplay form: action/environment narration in single asterisks, spoken dialogue in double quotes, authorized player inner voice in square brackets.',
  'Never nest dialogue inside action asterisks or leave bare prose. Close one form before starting the next.',
  'Example: *The pony raises an eyebrow.* "That is a good point." *He taps a hoof.*',
].join('\n');

export function v4RoleplayFormattingIssues(text: string) {
  const span = /\*[^*"“”\[\]]+\*|"[^"\[\]*]+"|“[^“”\[\]*]+”|\[[^\[\]*"“”]+\]/y;
  let index = 0;
  while (index < text.length) {
    if (/\s/u.test(text[index])) { index += 1; continue; }
    span.lastIndex = index;
    const match = span.exec(text);
    if (!match) return ['unbalanced, nested, or bare roleplay prose'];
    index = span.lastIndex;
  }
  return [];
}

function payload(text: string) {
  const roles = new Map<number, string>();
  // Complete independent spans retain their roles even beside malformed prose.
  for (const spans of [/\*[^*]+\*/g, /"[^"]+"|“[^“”]+”/g, /\[[^\[\]]+\]/g]) {
    for (const match of text.matchAll(spans)) {
      if (v4RoleplayFormattingIssues(match[0]).length) continue;
      const role = match[0][0] === '*' ? 'action' : match[0][0] === '[' ? 'thought' : 'dialogue';
      for (let index = match.index + 1; index < match.index + match[0].length - 1; index += 1) roles.set(index, role);
    }
  }
  const knownRoles: Array<string | undefined> = [];
  let offset = 0;
  for (const character of text) {
    if (!/[\s*"“”\[\]]/u.test(character)) {
      knownRoles.push(roles.get(offset));
    }
    offset += character.length;
  }
  return { wording: text.replace(/[*"“”\[\]]/g, '').replace(/\s+/gu, ' ').trim(), roles: knownRoles };
}

export function assertV4FormattingOnly(original: string, repaired: string) {
  const before = payload(original);
  const after = payload(repaired);
  if (before.wording !== after.wording
    || before.roles.some((role, index) => role !== undefined && role !== after.roles[index])) {
    throw new Error('V4 formatting repair changed prose content or an established role. The draft was discarded before commit.');
  }
}

/**
 * Split clearly spoken dialogue out of accidentally nested action markup.
 * Never ask an AI to rewrite a draft when a delimiter-only repair is provable.
 * Bare prose, ambiguous quotes and incomplete drafts are deliberately not guessed.
 */
export function tryV4LocalRoleplayRepair(draft: string): string | null {
  if (v4RoleplayFormattingIssues(draft).length === 0) return null;
  let changed = draft.replace(
    /\*([^*\[\]"“”\n]*?)("[^"\n]+"|“[^”\n]+”)([^*\[\]"“”\n]*?)\*/gu,
    (whole, before: string, dialogue: string, after: string) => {
      if (!/\b(?:says?|said|asks?|asked|replies?|replied|whispers?|whispered|shouts?|shouted|calls?|called|murmurs?|murmured|mutters?|muttered|answers?|answered|tells?|told|speaks?|spoke|states?|stated)\b/i.test(before)) return whole;
      return `${before.trim() ? `*${before.trim()}* ` : ''}${dialogue}${after.trim() ? ` *${after.trim()}*` : ''}`;
    },
  );
  // A complete, single-line action occasionally loses only its closing star.
  if (/^\*[^*"“”\[\]\n]+[.!?]$/u.test(changed)) changed += '*';
  if (changed === draft || v4RoleplayFormattingIssues(changed).length > 0) return null;
  try {
    assertV4FormattingOnly(draft, changed);
    return changed;
  } catch {
    return null;
  }
}
