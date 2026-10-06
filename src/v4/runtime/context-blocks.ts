export type V4ContextAudience = 'all' | 'resolver' | 'renderer' | 'autonomy';

export type V4ContextBlock = {
  id: string;
  title: string;
  content: string;
  priority: number;
  required?: boolean;
  audience?: V4ContextAudience;
};

export type V4ContextOmission = {
  id: string;
  title: string;
  reason: 'budget';
};

export type V4ContextSelection = {
  text: string;
  included: V4ContextBlock[];
  omitted: V4ContextOmission[];
  characters: number;
  estimatedTokens: number;
};

type IndexedBlock = V4ContextBlock & { index: number; rendered: string };

function renderBlock(block: V4ContextBlock) {
  const content = block.content.trim();
  return `${block.title}\n${content}\n`;
}

export function selectV4ContextBlocks(blocks: V4ContextBlock[], maxCharacters: number): V4ContextSelection {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) {
    throw new Error('V4 context budget must be a non-negative safe integer.');
  }

  const indexed: IndexedBlock[] = blocks.map((block, index) => ({
    ...block,
    index,
    rendered: renderBlock(block),
  }));

  const selected = new Set<number>();
  let used = 0;

  for (const block of indexed.filter((value) => value.required)) {
    if (used + block.rendered.length > maxCharacters) {
      // Deliberately loud. Silently dropping required current-scene context would
      // let the renderer continue from stale history, so the turn fails instead.
      throw new Error(
        'Speculus could not build a safe generation context because required current-scene context exceeded the available budget. No turn was generated or committed.',
        { cause: `Required V4 context block "${block.title}" needs ${used + block.rendered.length} characters but only ${maxCharacters} are available.` },
      );
    }
    selected.add(block.index);
    used += block.rendered.length;
  }

  const optional = indexed
    .filter((value) => !value.required)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  const omitted: V4ContextOmission[] = [];
  for (const block of optional) {
    if (used + block.rendered.length <= maxCharacters) {
      selected.add(block.index);
      used += block.rendered.length;
    } else {
      omitted.push({ id: block.id, title: block.title, reason: 'budget' });
    }
  }

  const included = indexed
    .filter((block) => selected.has(block.index))
    .sort((a, b) => a.index - b.index);

  const text = included.map((block) => block.rendered).join('');
  return {
    text,
    included: included.map(({ index: _index, rendered: _rendered, ...block }) => block),
    omitted,
    characters: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
  };
}
