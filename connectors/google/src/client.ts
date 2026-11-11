/** Request-scoped Google API transport. OAuth exchange and refresh belong to the gateway. */
import { createHash } from 'node:crypto';
import {
  callSignal,
  parseRetryAfterMs,
  RateLimitPacer,
  safeFetch,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';

export class GoogleResponseTooLargeError extends Error {
  constructor() {
    super('Google response exceeds size limit');
  }
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Google API request failed (${status})`);
  }
}

export class GoogleClient {
  constructor(
    private readonly accessToken: string,
    private readonly service: 'tasks' | 'people' | 'gmail' = 'tasks',
  ) {
    if (
      !accessToken ||
      ![...accessToken].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127)
    )
      throw new Error('A user access token is required');
  }

  async request(
    method: string,
    path: string,
    query: Record<string, unknown>,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const base =
      this.service === 'people'
        ? 'https://people.googleapis.com/v1/'
        : this.service === 'gmail'
          ? 'https://gmail.googleapis.com/gmail/v1/'
          : 'https://tasks.googleapis.com/tasks/v1/';
    const url = new URL(`${base}${path}`);
    const origin = new URL(base);
    if (
      url.origin !== origin.origin ||
      !url.pathname.startsWith(origin.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid Google API path');
    for (const [key, value] of Object.entries(query))
      if (value !== undefined)
        for (const item of Array.isArray(value) ? value : [value])
          url.searchParams.append(key, String(item));
    return withToolCallDeadline(20_000, async () => {
      const signal = callSignal()!;
      const pacer = new RateLimitPacer({
        namespace: `google-${this.service}`,
        maxAttempts: 3,
        retryStatuses: method === 'GET' ? [429, 500, 502, 503, 504] : [429],
        maxSingleWaitMs: 2000,
        totalWaitBudgetMs: 4000,
      });
      const { response, rateLimit } = await pacer.run(
        createHash('sha256').update(this.accessToken).digest('hex'),
        async () => {
          const response = await safeFetch(url.toString(), {
            method,
            signal,
            redirect: 'error',
            maxRedirects: 0,
            allowPrivate: false,
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              Accept: 'application/json',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          // Error bodies are never returned or retained, including responses discarded for retry.
          if (!response.ok) await response.body?.cancel();
          return response;
        },
      );
      if (response.status === 401) throw new UpstreamCredentialInvalidError();
      if (!response.ok)
        throw new GoogleApiError(
          response.status,
          rateLimit?.nextWaitMs ??
            parseRetryAfterMs(response.headers.get('retry-after'), Date.now()),
        );
      if (response.status === 204 || response.status === 205) return { success: true };
      const reader = response.body?.getReader();
      if (!reader) return { success: true };
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      try {
        signal.throwIfAborted();
        signal.addEventListener('abort', cancel, { once: true });
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) throw new GoogleResponseTooLargeError();
          chunks.push(part.value);
        }
        signal.throwIfAborted();
        const text = Buffer.concat(chunks).toString('utf8');
        const result: unknown = text ? JSON.parse(text) : { success: true };
        if (!result || typeof result !== 'object' || Array.isArray(result))
          throw new Error('Invalid Google response');
        return result as Record<string, unknown>;
      } finally {
        signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }
}
