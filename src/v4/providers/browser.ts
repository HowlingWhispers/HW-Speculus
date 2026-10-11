import type { ProviderAdapter, ProviderRequest, ProviderResult } from '../../runtime/providers/types';

export { v4RoleplayFormattingIssues } from '../runtime/output-format';

function gatewayBody(request: ProviderRequest, prompt: string, launchId: string) {
  return JSON.stringify({ ...request, prompt, signal: undefined, provider: 'orbis', launchId });
}

async function readGatewayResponse(response: Response, signal?: AbortSignal): Promise<ProviderResult> {
  let body: Partial<ProviderResult> & { error?: string };
  let rawText = '';
  try {
    rawText = await response.text();
    const value: unknown = JSON.parse(rawText);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
    body = value as typeof body;
  } catch {
    if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    const isHtml = rawText.trimStart().startsWith('<!doctype') || rawText.trimStart().startsWith('<html');
    throw new Error(
      isHtml
        ? `V4 generation gateway returned HTML instead of JSON (HTTP ${response.status}). The /api/v4/generate endpoint is likely not routed to the Speculus API server. Check reverse proxy configuration and SPECULUS_PUBLIC_ORIGIN.`
        : `V4 generation gateway returned an unreadable response (HTTP ${response.status}).`
    );
  }
  if (!response.ok) throw new Error(typeof body.error === 'string' && body.error ? body.error : `V4 generation failed (HTTP ${response.status}).`);
  if (typeof body.text !== 'string' || !body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) throw new Error('The V4 bridge returned an invalid response.');
  return { text: body.text, metadata: body.metadata };
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
    const result = await this.callGateway(request, request.prompt);
    if (request.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    return result;
  }
}
