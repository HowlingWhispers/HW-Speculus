import type { ProviderKind, SafeProviderMetadata } from '../schema/types.js';

export type ProviderRequest = {
  engine?: 'v1' | 'v2';
  prompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topK: number;
  topP: number;
  presencePenalty: number;
  frequencyPenalty: number;
  stopSequences: string[];
  continueToEndOfSentence: boolean;
  reroll?: boolean;
  signal?: AbortSignal;
};

export type ProviderResult = { text: string; metadata: SafeProviderMetadata };

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  generate(request: ProviderRequest): Promise<ProviderResult>;
}
