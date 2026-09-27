import { z } from 'zod';
import type { CharacterCard, Persona } from './types';

const text = z.string().max(100_000).default('');
const characterDataSchema = z.object({
  name: z.string().trim().min(1, 'Character name is missing.').max(160),
  description: text,
  personality: text,
  scenario: text,
  first_mes: text,
  mes_example: text,
  system_prompt: text,
  post_history_instructions: text,
  tags: z.array(z.string().max(100)).default([]),
}).passthrough();

const characterV2Schema = z.object({
  spec: z.literal('chara_card_v2'),
  data: characterDataSchema,
}).passthrough();

const personaSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1, 'Persona name is missing.').max(160),
  description: z.string().max(50_000).optional(),
  persona: z.string().max(50_000).optional(),
  details: z.string().max(50_000).optional(),
  kind: z.string().optional(),
  spec: z.string().optional(),
}).passthrough();

function stableSlug(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'subject';
}

function parseJson(input: string | unknown): unknown {
  if (typeof input !== 'string') return input;
  try { return JSON.parse(input); } catch { throw new Error('The selected file is not valid JSON.'); }
}

export function importCharacterCard(input: string | unknown): CharacterCard {
  const value = parseJson(input);
  const parsed = characterV2Schema.safeParse(value);
  if (!parsed.success) {
    if (typeof value === 'object' && value !== null && 'name' in value && !('spec' in value)) {
      throw new Error('This is not a Character Card V2 file. Expected spec "chara_card_v2" and a data object.');
    }
    throw new Error(`Character import failed: ${parsed.error.issues[0]?.message ?? 'invalid Character Card V2 data.'}`);
  }
  const data = parsed.data.data;
  return {
    kind: 'character', id: `char:${stableSlug(data.name)}`, spec: 'chara_card_v2', name: data.name,
    description: data.description, personality: data.personality, scenario: data.scenario,
    firstMessage: data.first_mes, exampleDialogue: data.mes_example, systemPrompt: data.system_prompt,
    postHistoryInstructions: data.post_history_instructions, tags: data.tags,
  };
}

export function importPersona(input: string | unknown): Persona {
  const value = parseJson(input);
  if (typeof value === 'object' && value !== null && ('data' in value || (value as { spec?: string }).spec === 'chara_card_v2' || (value as { kind?: string }).kind === 'character')) {
    throw new Error('That file is a character card, not a persona.');
  }
  const parsed = personaSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Persona import failed: ${parsed.error.issues[0]?.message ?? 'invalid persona data.'}`);
  const description = parsed.data.description ?? parsed.data.persona ?? parsed.data.details ?? '';
  return { kind: 'persona', id: parsed.data.id ?? `persona:${stableSlug(parsed.data.name)}`, name: parsed.data.name, description, document: {} };
}

export function createTemporaryPersona(name: string, description: string): Persona {
  return importPersona({ name, description, id: `persona:${stableSlug(name)}` });
}
