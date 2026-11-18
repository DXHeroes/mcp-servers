/** Delegated Microsoft Graph transport. Tokens and refresh remain owned by the gateway. */
import { createHash } from 'node:crypto';
import {
  callSignal,
  parseRetryAfterMs,
  RateLimitPacer,
  safeFetch,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly reason?: 'mailbox_rest_unavailable',
  ) {
    super(`Microsoft Graph request failed (${status})`);
  }
}
export class GraphInputError extends Error {}
const base = 'https://graph.microsoft.com/v1.0/';
type GraphRoot = 'me' | 'chats' | 'teams' | 'users';
export interface GraphClientOptions {
  roots?: readonly GraphRoot[];
  headers?: Readonly<Record<string, string>>;
  diagnoseMailboxErrors?: boolean;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readGraphObject(response: Response, signal: AbortSignal, maxBytes: number) {
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
      if (size > maxBytes) throw new Error('Graph response exceeds size limit');
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    const text = Buffer.concat(chunks).toString('utf8');
    const data = text ? asObject(JSON.parse(text)) : { success: true };
    if (!data) throw new Error('Invalid Graph response');
    return data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function mailboxErrorReason(response: Response, signal: AbortSignal) {
  const body = await readGraphObject(response, signal, 16 * 1024).catch(() => undefined);
  signal.throwIfAborted();
  let error = asObject(body?.error);
  while (error) {
    if (
      error.code === 'MailboxNotEnabledForRESTAPI' ||
      error.code === 'MailboxNotSupportedForRESTAPI'
    ) {
      return 'mailbox_rest_unavailable' as const;
    }
    error = asObject(error.innererror ?? error.innerError);
  }
  return undefined;
}
function segments(path: string): string[] {
  try {
    return path.split('/').map((part) => decodeURIComponent(part));
  } catch {
    throw new GraphInputError();
  }
}
function ownerAlias(parts: string[]): string[] {
  let result =
    parts[2] === 'users' && parts.length > 4
      ? [...parts.slice(0, 2), 'me', ...parts.slice(4)]
      : parts;
  if (result[2] === 'me' && result[3] === 'chats')
    result = [...result.slice(0, 2), ...result.slice(3)];
  return result;
}
export class GraphClient {
  private readonly roots: ReadonlySet<GraphRoot>;
  private readonly headers: Headers;
  private readonly diagnoseMailboxErrors: boolean;
  constructor(
    private readonly token: string,
    options: GraphClientOptions = {},
  ) {
    const roots = options.roots ?? ['me'];
    if (!roots.length || roots.some((root) => !['me', 'chats', 'teams', 'users'].includes(root)))
      throw new GraphInputError();
    this.roots = new Set(roots);
    this.headers = new Headers(options.headers);
    this.diagnoseMailboxErrors = options.diagnoseMailboxErrors ?? false;
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
    const expected = segments(url.pathname);
    if (
      url.origin !== 'https://graph.microsoft.com' ||
      expected[1] !== 'v1.0' ||
      !this.roots.has(expected[2] as GraphRoot)
    )
      throw new GraphInputError();
    if (nextLink) {
      if (method !== 'GET') throw new GraphInputError();
      const next = new URL(nextLink);
      const aliases = expected[2] === 'me' || expected[2] === 'chats';
      const normalize = (parts: string[]) => (aliases ? ownerAlias(parts) : parts);
      if (
        next.origin !== url.origin ||
        next.protocol !== 'https:' ||
        next.username ||
        next.password ||
        next.hash ||
        JSON.stringify(normalize(segments(next.pathname))) !== JSON.stringify(normalize(expected))
      )
        throw new GraphInputError();
      url.search = next.search;
    } else {
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return withToolCallDeadline(20_000, async () => {
      const signal = callSignal()!;
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
          const headers = new Headers(this.headers);
          headers.set('Authorization', `Bearer ${this.token}`);
          headers.set('Accept', 'application/json');
          if (body !== undefined) headers.set('Content-Type', 'application/json');
          const result = await safeFetch(url.toString(), {
            method,
            signal,
            redirect: 'error',
            maxRedirects: 0,
            allowPrivate: false,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          // A diagnosed 404 is never retried by the pacer. All other error bodies
          // are discarded before a possible retry.
          if (!result.ok && !(this.diagnoseMailboxErrors && result.status === 404)) {
            await result.body?.cancel();
          }
          return result;
        },
      );
      if (response.status === 401) throw new UpstreamCredentialInvalidError();
      if (!response.ok) {
        const reason =
          this.diagnoseMailboxErrors && response.status === 404
            ? await mailboxErrorReason(response, signal)
            : undefined;
        throw new GraphApiError(
          response.status,
          rateLimit?.nextWaitMs ??
            parseRetryAfterMs(response.headers.get('retry-after'), Date.now()),
          reason,
        );
      }
      if (response.status === 204 || response.status === 205) return { success: true };
      return readGraphObject(response, signal, 2 * 1024 * 1024);
    });
  }
}
