import type { ProviderAdapter, ProviderRequest, ProviderResult } from '../../runtime/providers/types';

const V4_ROLEPLAY_FORMAT_CONTRACT = [
  'SPECULUS V4 ROLEPLAY FORMAT CONTRACT',
  'Formatting is structural, not decorative. Every visible prose span must use exactly one roleplay form:',
  '- action or environmental narration: single asterisks, for example *The pony raises an eyebrow.*',
  '- spoken dialogue: double quotes, for example "That is a good point."',
  '- player inner voice only when explicitly authorized: square brackets, for example [I should be careful.]',
  'Never put spoken dialogue inside asterisks. Never leave action, narration, or dialogue as bare unmarked prose.',
  'When action and dialogue alternate, close one form before starting the next.',
  'Correct pattern:',
  '*The pony raises an eyebrow.*',
  '"That is a good point."',
  '*He taps a hoof against the ground.*',
  '"So, are you here for the show?"',
].join('\n');

const RESPONSE_CUE = '\n\n[IN-WORLD RESPONSE]';

function promptWithFormatContract(prompt: string) {
  const cueIndex = prompt.lastIndexOf(RESPONSE_CUE);
  if (cueIndex < 0) return `${prompt}\n\n${V4_ROLEPLAY_FORMAT_CONTRACT}`;
  return `${prompt.slice(0, cueIndex)}\n\n${V4_ROLEPLAY_FORMAT_CONTRACT}${prompt.slice(cueIndex)}`;
}

function gatewayBody(request: ProviderRequest, prompt: string, launchId: string) {
  return JSON.stringify({ ...request, prompt, signal: undefined, provider: 'orbis', launchId });
}

async function readGatewayResponse(response: Response, signal?: AbortSignal): Promise<ProviderResult> {
  let body: Partial<ProviderResult> & { error?: string };
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
    body = value as typeof body;
  } catch {
    if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    throw new Error(`V4 generation gateway returned an unreadable response (HTTP ${response.status}). Check the Speculus API and reverse proxy.`);
  }
  if (!response.ok) throw new Error(typeof body.error === 'string' && body.error ? body.error : `V4 generation failed (HTTP ${response.status}).`);
  if (typeof body.text !== 'string' || !body.metadata) throw new Error('The V4 bridge returned an invalid response.');
  return { text: body.text, metadata: body.metadata };
}

function roleplayContentFingerprint(text: string) {
  return text
    .normalize('NFKC')
    .replace(/[\*"“”\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function v4RoleplayFormattingIssues(text: string) {
  const issues: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return issues;

  const asteriskCount = trimmed.match(/\*/g)?.length ?? 0;
  const straightQuoteCount = trimmed.match(/"/g)?.length ?? 0;
  const leftCurlyQuoteCount = trimmed.match(/“/g)?.length ?? 0;
  const rightCurlyQuoteCount = trimmed.match(/”/g)?.length ?? 0;
  const leftBracketCount = trimmed.match(/\[/g)?.length ?? 0;
  const rightBracketCount = trimmed.match(/\]/g)?.length ?? 0;

  if (asteriskCount % 2 !== 0) issues.push('unbalanced action asterisks');
  if (straightQuoteCount % 2 !== 0 || leftCurlyQuoteCount !== rightCurlyQuoteCount) issues.push('unbalanced dialogue quotes');
  if (leftBracketCount !== rightBracketCount) issues.push('unbalanced inner-voice brackets');

  const actionSegments = trimmed.split('*');
  const actionContainsDialogue = actionSegments.some((segment, index) =>
    index % 2 === 1 && /(?:"[^"]+"|“[^”]+”)/s.test(segment));
  if (actionContainsDialogue) issues.push('dialogue nested inside action italics');

  const residue = trimmed
    .replace(/\*[^*]+\*/gs, ' ')
    .replace(/"[^"]+"/gs, ' ')
    .replace(/“[^”]+”/gs, ' ')
    .replace(/\[[^\]]+\]/gs, ' ')
    .replace(/[\s.,!?;:(){}…—–\-_'`/\\]+/g, '');
  if (/[\p{L}\p{N}]/u.test(residue)) issues.push('bare prose outside roleplay delimiters');

  return issues;
}

function formatRepairPrompt(draft: string) {
  return [
    V4_ROLEPLAY_FORMAT_CONTRACT,
    '',
    'FORMAT REPAIR ONLY',
    'Reformat the exact draft below. Preserve every word, sentence, name, fact, action, and ordering.',
    'You may only add, remove, or move roleplay delimiters and whitespace needed to satisfy the format contract.',
    'Do not paraphrase, expand, shorten, sanitize, continue, or otherwise rewrite the prose.',
    'Return only the repaired in-world roleplay text.',
    '',
    'DRAFT TO REPAIR:',
    draft,
  ].join('\n');
}

export class V4BrowserProvider implements ProviderAdapter {
  readonly kind = 'orbis' as const;
  constructor(private readonly launchId: string) {}

  private async callGateway(request: ProviderRequest, prompt: string): Promise<ProviderResult> {
    const response = await fetch('/api/v4/generate', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: gatewayBody({ ...request, signal: undefined }, prompt, this.launchId), signal: request.signal,
    });
    return readGatewayResponse(response, request.signal);
  }

  async generate(request: ProviderRequest): Promise<ProviderResult> {
    const result = await this.callGateway(request, promptWithFormatContract(request.prompt));
    if (request.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    if (result.metadata.completionStatus === 'max_tokens') return result;

    const formatIssues = v4RoleplayFormattingIssues(result.text);
    if (!formatIssues.length) return result;

    const repaired = await this.callGateway({
      ...request,
      temperature: Math.min(request.temperature, 0.2),
      presencePenalty: 0,
      frequencyPenalty: 0,
      reroll: false,
    }, formatRepairPrompt(result.text));

    if (roleplayContentFingerprint(repaired.text) !== roleplayContentFingerprint(result.text)) {
      throw new Error('V4 roleplay formatting repair changed prose content, so the draft was discarded before commit.');
    }

    const remainingIssues = v4RoleplayFormattingIssues(repaired.text);
    if (remainingIssues.length) {
      throw new Error(`V4 roleplay formatting repair was still invalid (${remainingIssues.join(', ')}), so the draft was discarded before commit.`);
    }

    return {
      text: repaired.text,
      metadata: {
        ...repaired.metadata,
        durationMs: result.metadata.durationMs + repaired.metadata.durationMs,
      },
    };
  }
}
