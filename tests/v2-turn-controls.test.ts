import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderRequest } from '../src/runtime/providers/types';
import { publicV2Package } from '../src/v2/contracts/launch';
import { generateV2Turn } from '../src/v2/runtime/engine';
import { generateV2PersonaDraft } from '../src/v2/runtime/persona-draft';
import { createV2Session } from '../src/v2/runtime/session';
import { SKIPPED_PERSONA_TURN } from '../src/v2/runtime/turn-control';
import { v2Package } from './v2-fixtures';

const session = () => ({ ...createV2Session(publicV2Package(v2Package())), draft: '*I wait.*' });
const adapter = (text: string) => ({
  kind: 'mock',
  generate: vi.fn(async () => ({
    text,
    metadata: { provider: 'mock' as const, model: 'xialong-v1', endpoint: 'mock', durationMs: 1, completionStatus: 'completed' as const },
  })),
}) satisfies ProviderAdapter;

describe('V2 operator turn controls', () => {
  it('skips the persona without inventing a player message or erasing an unsent draft', async () => {
    const value = session();
    const provider = adapter('*Peony looks toward the door.* "Still here."');
    const phases: string[] = [];
    const next = await generateV2Turn(value, provider, { skipPersona: true, onPhase: (phase) => phases.push(phase) });
    expect(next.turns[0].player).toBe(SKIPPED_PERSONA_TURN);
    expect(next.draft).toBe(value.draft);
    expect(next.events[0].label).toContain('persona skipped');
    expect(phases).toEqual(['resolve', 'context', 'generate', 'validate', 'commit']);
    const request = provider.generate.mock.calls[0] as unknown as [ProviderRequest];
    expect(request[0].prompt).toContain('Player persona turn skipped');
    expect(request[0].prompt).not.toContain(`[PLAYER INPUT]\n${SKIPPED_PERSONA_TURN}`);
  });

  it('impersonates only the player persona and returns the result to an empty composer path without a commit phase', async () => {
    const value = session();
    value.draft = '';
    const provider = adapter('*I fold my arms.* "Fine."');
    const phases: string[] = [];
    const draft = await generateV2PersonaDraft(value, provider, { onPhase: (phase) => phases.push(phase) });
    expect(draft).toBe('*I fold my arms.* "Fine."');
    expect(phases).toEqual(['context', 'generate', 'validate']);
    const request = provider.generate.mock.calls[0] as unknown as [ProviderRequest];
    expect(request[0].prompt).toContain('PLAYER PERSONA / AUTHORIZED SUBJECT');
    expect(request[0].prompt).toContain('CHARACTER OR NARRATOR / NEVER IMPERSONATE');
    expect(request[0].prompt).toContain('Do not write, continue, react for, or impersonate the character or simulation narrator.');
  });

  it('uses an existing composer draft as fixed context and appends only the generated continuation', async () => {
    const value = session();
    value.draft = '*At sundown*';
    const provider = adapter('*I tighten my cloak.* "Time to go."');
    const draft = await generateV2PersonaDraft(value, provider);
    expect(draft).toBe('*At sundown*\n*I tighten my cloak.* "Time to go."');
    const request = provider.generate.mock.calls[0] as unknown as [ProviderRequest];
    expect(request[0].prompt).toContain('player composer already contains');
    expect(request[0].prompt).toContain('*At sundown*');
    expect(request[0].prompt).toContain('Generate only the new continuation');
  });

  it('does not duplicate an existing composer prefix when the provider echoes it anyway', async () => {
    const value = session();
    value.draft = '*At sundown*';
    const draft = await generateV2PersonaDraft(value, adapter('*At sundown* *I head for the gate.*'));
    expect(draft).toBe('*At sundown*\n*I head for the gate.*');
  });

  it('rejects a player impersonation draft that starts writing the character turn', async () => {
    const value = session();
    value.draft = '';
    await expect(generateV2PersonaDraft(value, adapter('*Peony steps closer.* "No."'))).rejects.toThrow('character turn');
  });
});
