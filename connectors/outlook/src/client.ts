/** Delegated Microsoft Graph transport. Tokens and refresh remain owned by the gateway. */
import { createHash } from 'node:crypto';
import {
  callSignal,
  parseRetryAfterMs,
  RateLimitPacer,
  safeFetch,
  withToolCallContext,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Microsoft Graph request failed (${status})`);
  }
}
export class GraphInputError extends Error {}
const base = 'https://graph.microsoft.com/v1.0/';
export class GraphClient {
  constructor(private readonly token: string) {
    if (!token || ![...token].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127))
      throw new Error('A user access token is required');
  }
  async request(
    method: string,
    path: string,
    query: Record<string, unknown> = {},
    body?: unknown,
    nextLink?: string,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${base}${path}`);
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/me'))
      throw new GraphInputError();
    if (nextLink) {
      if (method !== 'GET') throw new GraphInputError();
      const next = new URL(nextLink);
      // Graph may canonicalize /me as /users/{id}; always send delegated calls to /me.
      const reboundPath = next.pathname.replace(/^\/v1\.0\/users\/[^/]+(?=\/)/, '/v1.0/me');
      if (
        next.origin !== url.origin ||
        next.protocol !== 'https:' ||
        next.username ||
        next.password ||
        next.hash ||
        reboundPath !== url.pathname
      )
        throw new GraphInputError();
      url.search = next.search;
    } else {
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const signal = callSignal(AbortSignal.timeout(20_000))!;
    return withToolCallContext({ signal }, async () => {
      const pacer = new RateLimitPacer({
        namespace: 'microsoft-graph',
        maxAttempts: 3,
        retryStatuses: method === 'GET' ? [429, 500, 502, 503, 504] : [429],
        maxSingleWaitMs: 2000,
        totalWaitBudgetMs: 4000,
      });
      const { response, rateLimit } = await pacer.run(
        createHash('sha256').update(this.token).digest('hex'),
        async () => {
          const result = await safeFetch(url.toString(), {
            method,
            signal,
            redirect: 'error',
            maxRedirects: 0,
            allowPrivate: false,
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: 'application/json',
              Prefer: 'outlook.timezone="UTC"',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          if (!result.ok) await result.body?.cancel();
          return result;
        },
      );
      if (response.status === 401) throw new UpstreamCredentialInvalidError();
      if (!response.ok)
        throw new GraphApiError(
          response.status,
          rateLimit?.nextWaitMs ??
            parseRetryAfterMs(response.headers.get('retry-after'), Date.now()),
        );
      if (response.status === 204 || response.status === 205) return { success: true };
      const reader = response.body?.getReader();
      if (!reader) return { success: true };
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error('Graph response exceeds size limit');
          chunks.push(part.value);
        }
        signal.throwIfAborted();
        const text = Buffer.concat(chunks).toString('utf8');
        const data: unknown = text ? JSON.parse(text) : { success: true };
        if (!data || typeof data !== 'object' || Array.isArray(data))
          throw new Error('Invalid Graph response');
        return data as Record<string, unknown>;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }
}
