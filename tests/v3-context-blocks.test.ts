import { describe, expect, it } from 'vitest';
import { selectV3ContextBlocks, type V3ContextBlock } from '../src/v3/runtime/context-blocks';

const block = (id: string, content: string, priority: number, required = false): V3ContextBlock => ({
  id,
  title: id.toUpperCase(),
  content,
  priority,
  required,
});

describe('V3 context block selection', () => {
  it('keeps required blocks and drops lower-priority optional blocks whole', () => {
    const blocks = [
      block('core', 'required-state', 100, true),
      block('low', 'x'.repeat(20), 1),
      block('high', 'important', 50),
    ];
    const requiredLength = 'CORE\nrequired-state\n'.length;
    const highLength = 'HIGH\nimportant\n'.length;
    const result = selectV3ContextBlocks(blocks, requiredLength + highLength);

    expect(result.included.map((value) => value.id)).toEqual(['core', 'high']);
    expect(result.omitted).toEqual([{ id: 'low', title: 'LOW', reason: 'budget' }]);
    expect(result.text).not.toContain('x'.repeat(20));
  });

  it('preserves original output order after priority-based admission', () => {
    const blocks = [
      block('first', 'one', 1),
      block('second', 'two', 100),
      block('third', 'three', 50),
    ];
    const result = selectV3ContextBlocks(blocks, 10_000);
    expect(result.included.map((value) => value.id)).toEqual(['first', 'second', 'third']);
    expect(result.text.indexOf('FIRST')).toBeLessThan(result.text.indexOf('SECOND'));
  });

  it('fails closed when required context cannot fit', () => {
    // Loud failure by design: silently dropping required current-scene context
    // would let the renderer continue from stale history.
    expect(() => selectV3ContextBlocks([block('core', 'required-state', 100, true)], 4))
      .toThrow('Speculus could not build a safe generation context because required current-scene context exceeded the available budget. No turn was generated or committed.');
  });

  it('reports which required block overflowed without dumping context', () => {
    try {
      selectV3ContextBlocks([block('core', 'required-state', 100, true)], 4);
      throw new Error('expected a throw');
    } catch (cause) {
      const error = cause as Error;
      expect(error.cause).toContain('CORE');
      expect(error.cause).toContain('available');
    }
  });
});
