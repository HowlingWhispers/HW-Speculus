export type CharacterCard = {
  kind: 'character';
  id: string;
  spec: 'chara_card_v2';
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  tags: string[];
};

export type Persona = {
  kind: 'persona';
  id: string;
  name: string;
  description: string;
};

export type TranscriptMessage = {
  id: string;
  turnId: string;
  sender: 'player' | 'character' | 'system';
  speaker: string;
  text: string;
  timestamp: number;
};

export type ProviderKind = 'mock' | 'orbis';

export type ProviderSettings = {
  kind: ProviderKind;
  model: string;
  preset: 'novelai-default' | 'custom';
  temperature: number;
  maxTokens: number;
  outputLengthCharacters: number;
  topK: number;
  topP: number;
  presencePenalty: number;
  frequencyPenalty: number;
  stopSequences: string[];
  continueToEndOfSentence: boolean;
};

export type SimulationAssetType = 'character' | 'world' | 'place' | 'item' | 'faction' | 'other';

export type SimulationAsset = {
  id: string;
  revision: string;
  type: SimulationAssetType;
  name: string;
  summary: string;
  data: unknown;
};

export type SpeculusCatalogStatus = 'active' | 'archived' | 'retired' | 'sealed' | 'legacy';

export type SpeculusCatalogIdentity = {
  code: string;
  prefix: string;
  plate: string;
  generation: number;
  registryNumber: number;
  classRegistryNumber: number;
  classification: string;
  createdAt: string;
  status: SpeculusCatalogStatus;
};

export type ContextBlock = { id: string; title: string; content: string };

export type OrbisLaunchPackage = {
  version: 1;
  launchId: string;
  issuedAt: number;
  expiresAt: number;
  initialLocationId?: string;
  catalog?: SpeculusCatalogIdentity;
  primaryAsset: SimulationAsset;
  relatedAssets: SimulationAsset[];
  character: CharacterCard | null;
  persona: Persona;
  scene: string;
  contextBlocks: ContextBlock[];
  relationshipState: import('../relationships/schema.js').RelationshipState;
  model: string;
  generationGrant: string;
};

export type ClientLaunchPackage = Omit<OrbisLaunchPackage, 'generationGrant'>;

export type PerceptionResult = {
  input: string;
  sceneFacts: string[];
  visibleSubjects: string[];
  mentionedNames: string[];
  filtered: Array<{ value: string; reason: string }>;
};

export type ActiveCastResult = {
  primaryId: string;
  primaryName: string;
  active: Array<{ id: string; name: string; reason: string }>;
  mentionedOnly: string[];
};

export type ContextManifest = {
  compilerVersion: 1 | 2;
  includedSections: string[];
  includedMessages: number;
  estimatedInputTokens: number;
  characterId: string;
  personaId: string;
  scene: string;
  targetProtocol?: SimulationAssetType;
  responseMode?: import('../brain/contracts.js').ResponseMode;
  maximumBeats?: number;
  policyProfileId?: string;
};

export type CompiledContext = { prompt: string; manifest: ContextManifest };

export type SafeProviderMetadata = {
  provider: ProviderKind;
  model: string;
  endpoint: string;
  durationMs: number;
  requestId?: string;
  inputTokensEstimate?: number;
  completionStatus?: 'completed' | 'max_tokens' | 'timeout' | 'cancelled' | 'bridge_interruption' | 'unknown';
  finishReason?: string;
  requestedMaxTokens?: number;
};

export type DiagnosticsSnapshot = {
  turnId: string;
  createdAt: number;
  inputEvent: TranscriptMessage;
  perception: PerceptionResult;
  activeCast: ActiveCastResult;
  relationshipBefore: unknown;
  relationshipAfter: unknown;
  relationshipEvent: unknown;
  compiledContext: CompiledContext;
  provider: SafeProviderMetadata;
  brain?: {
    config: import('../brain/contracts.js').SpeculusBrainConfigV1;
    beatPlan: import('../brain/contracts.js').BeatPlanV1;
    authority: import('../brain/contracts.js').TurnAuthorityV1;
    validation: import('../brain/contracts.js').DraftValidationResult;
  };
  finalReply: string;
  previousReply?: string;
};
