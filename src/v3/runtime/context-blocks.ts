export type V3ContextAudience = 'all' | 'resolver' | 'renderer' | 'autonomy';

export type V3ContextBlock = {
  id: string;
  title: string;
  content: string;
  priority: number;
  required?: boolean;
  audience?: V3ContextAudience;
};

export type V3ContextOmission = {
  id: string;
  title: string;
  reason: 'budget';
};

export type V3ContextSelection = {
  text: string;
  included: V3ContextBlock[];
  omitted: V3ContextOmission[];
  characters: number;
  estimatedTokens: number;
};

type IndexedBlock = V3ContextBlock & { index: number; rendered: string };

function renderBlock(block: V3ContextBlock) {
  const content = block.content.trim();
  return `${block.title}\n${content}\n`;
}

export function selectV3ContextBlocks(blocks: V3ContextBlock[], maxCharacters: number): V3ContextSelection {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) {
    throw new Error('V3 context budget must be a non-negative safe integer.');
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
      throw new Error(`Required V3 context block "${block.title}" exceeds the remaining context budget.`);
    }
    selected.add(block.index);
    used += block.rendered.length;
  }

  const optional = indexed
    .filter((value) => !value.required)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  const omitted: V3ContextOmission[] = [];
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
