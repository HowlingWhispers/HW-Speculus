import { describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v2/contracts/launch';
import { createV2Session } from '../src/v2/runtime/session';
import { loadLatestV2LocalAutosave, saveV2LocalAutosave, V2_LAST_AUTOSAVE_KEY } from '../src/v2/storage/autosave';
import { v2Package } from './v2-fixtures';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('V2 rolling autosave', () => {
  it('keeps one latest authorization-free raw save for the same simulation identity', () => {
    const storage = memoryStorage();
    const session = createV2Session(publicV2Package(v2Package()));
    const first = saveV2LocalAutosave(session, storage);
    session.draft = 'updated';
    const second = saveV2LocalAutosave(session, storage);
    expect(second.key).toBe(first.key);
    expect(storage.getItem(V2_LAST_AUTOSAVE_KEY)).toBe(first.key);
    const latest = loadLatestV2LocalAutosave(storage);
    expect(latest?.raw).toContain('updated');
    expect(latest?.raw).not.toContain(session.launch.launchId);
    expect(latest?.raw).not.toContain('generationGrant');
  });
});
