import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// Execute the entry's actual route conditions with imports replaced by a recorder.
const route = new Function('window', 'load', readFileSync('src/main.tsx', 'utf8')
  .replace(/void import\(([^)]+)\)/g, 'load($1)')
  .replace('export {};', ''));

describe('runtime entry routing', () => {
  it.each([
    ['/', 'v4'], ['/v4', 'v4'], ['/v4/display', 'v4'], ['/unknown', 'v4'],
    ['/v1', 'v1'], ['/v1/display', 'v1'], ['/v2', 'v2'], ['/v2/display', 'v2'],
    ['/v3', 'v3'], ['/v3/display', 'v3'], ['/v30', 'v4'],
  ])('routes %s exclusively to %s', (path, runtime) => {
    const loaded = vi.fn();
    route({ location: { pathname: path } }, loaded);
    expect(loaded).toHaveBeenCalledWith(runtime === 'v1' ? './v1-entry' : `./${runtime}/main`);
    expect(loaded).toHaveBeenCalledTimes(1);
  });
});
