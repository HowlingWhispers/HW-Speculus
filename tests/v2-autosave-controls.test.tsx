import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publicV2Package } from '../src/v2/contracts/launch';
import { createV2Session } from '../src/v2/runtime/session';
import { loadLatestV2LocalAutosave } from '../src/v2/storage/autosave';
import { saveV2Session } from '../src/v2/storage/session';
import { V2AutosaveControls } from '../src/v2/ui/AutosaveControls';
import { v2Package } from './v2-fixtures';

describe('V2 autosave controls', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('autosaves an unsent draft before the first generated turn and exposes Save now', async () => {
    const session = createV2Session(publicV2Package(v2Package()));
    session.draft = '*Unsent words that must survive.*';
    saveV2Session(session);

    render(<V2AutosaveControls />);

    expect(screen.getByRole('button', { name: 'Save now' })).toBeInTheDocument();
    await waitFor(() => expect(loadLatestV2LocalAutosave()?.raw).toContain('Unsent words that must survive.'));
    expect(loadLatestV2LocalAutosave()?.raw).not.toContain(session.launch.launchId);
  });
});
