import type { ProviderAdapter, ProviderRequest, ProviderResult } from '../../runtime/providers/types';

export class V2BrowserProvider implements ProviderAdapter {
  readonly kind = 'orbis' as const;
  constructor(private readonly launchId: string) {}

  async generate(request: ProviderRequest): Promise<ProviderResult> {
    const response = await fetch('/api/v2/generate', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, signal: undefined, provider: 'orbis', launchId: this.launchId }), signal: request.signal,
    });
    let body: Partial<ProviderResult> & { error?: string };
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
      body = value as typeof body;
    } catch {
      if (request.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      throw new Error(`V2 generation gateway returned an unreadable response (HTTP ${response.status}). Check the Speculus API and reverse proxy.`);
    }
    if (!response.ok) throw new Error(typeof body.error === 'string' && body.error ? body.error : `V2 generation failed (HTTP ${response.status}).`);
    if (typeof body.text !== 'string' || !body.metadata) throw new Error('The V2 bridge returned an invalid response.');
    return { text: body.text, metadata: body.metadata };
  }
}
