import { beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/runtime/providers/mock';
import { publicV4Package } from '../src/v4/contracts/launch';
import { createRootBranch, projectBranch } from '../src/v4/runtime/branches';
import { compileV4Context } from '../src/v4/runtime/context';
import { generateV4Turn } from '../src/v4/runtime/engine';
import { createV4Session, DEFAULT_GENERATED_TEXT_FONT_SIZE, diagnosticsSchema, settingsSchema } from '../src/v4/runtime/session';
import { createBranchRepository } from '../src/v4/storage/branches';
import { exportV4Session, importV4Session, loadV4Session, saveV4Session, V4_STORAGE_KEY } from '../src/v4/storage/session';
import { v2Package } from './v2-fixtures';
import { IndexedDBDouble } from './v4-indexeddb-fixture';

const fresh = () => createV4Session(publicV4Package(v2Package()));
beforeEach(() => sessionStorage.clear());

describe('V4 generated reply text size state', () => {
  it('defaults missing display preferences to 20px', () => {
    expect(DEFAULT_GENERATED_TEXT_FONT_SIZE).toBe(20);
    expect(settingsSchema.parse({}).generatedTextFontSize).toBe(20);
    const session = fresh();
    expect(session.settings.generatedTextFontSize).toBe(20);
    saveV4Session(session);
    const oldSave = JSON.parse(sessionStorage.getItem(V4_STORAGE_KEY)!);
    delete oldSave.settings.generatedTextFontSize;
    sessionStorage.setItem(V4_STORAGE_KEY, JSON.stringify(oldSave));
    expect(loadV4Session()?.settings.generatedTextFontSize).toBe(20);
    const oldExport = JSON.parse(exportV4Session(session));
    delete oldExport.settings.generatedTextFontSize;
    expect(importV4Session(JSON.stringify(oldExport), fresh()).settings.generatedTextFontSize).toBe(20);
  });

  it.each([14, 20, 32])('accepts integer size %ipx', (generatedTextFontSize) => {
    expect(settingsSchema.parse({ generatedTextFontSize }).generatedTextFontSize).toBe(generatedTextFontSize);
  });

  it.each([13, 33, 20.5, NaN, Infinity, '20', null])('rejects invalid size %j', (generatedTextFontSize) => {
    expect(settingsSchema.safeParse({ generatedTextFontSize }).success).toBe(false);
  });

  it('keeps the preference out of generation diagnostics and compiled prompts', async () => {
    const session = await generateV4Turn({ ...fresh(), draft: '*I wait.*' }, new MockProvider());
    const changed = { ...session, settings: { ...session.settings, generatedTextFontSize: 32 } };
    expect(compileV4Context(changed, '*I look.*')).toEqual(compileV4Context(session, '*I look.*'));
    const diagnostics = diagnosticsSchema.parse({ ...session.turns[0].diagnostics,
      generationSettings: { ...session.settings, generatedTextFontSize: 32 } });
    expect(diagnostics.generationSettings).not.toHaveProperty('generatedTextFontSize');
  });

  it('round-trips the selected size through session storage, export/import, and durable branches', async () => {
    const session = fresh();
    session.settings.generatedTextFontSize = 27;
    saveV4Session(session);
    expect(loadV4Session()?.settings.generatedTextFontSize).toBe(27);
    expect(importV4Session(exportV4Session(session), fresh()).settings.generatedTextFontSize).toBe(27);
    const db = new IndexedDBDouble();
    const branch = createRootBranch(session);
    await createBranchRepository({ indexedDB: db.factory }).saveBranch(branch, branch.source, {
      expectedRevision: null, expectedSelectionRevision: null, activate: true,
    });
    const restored = (await createBranchRepository({ indexedDB: db.factory }).loadActiveBranch())!.branch;
    expect(projectBranch(restored, session.launch).settings.generatedTextFontSize).toBe(27);
  });
});
