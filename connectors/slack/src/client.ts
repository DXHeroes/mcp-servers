import { createHash } from 'node:crypto';
import {
  callSignal,
  parseRetryAfterMs,
  RateLimitPacer,
  safeFetch,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';

const methods = new Set([
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'search.messages',
  'users.list',
  'users.info',
  'chat.postMessage',
  'reactions.add',
]);
const safeReasons = new Set([
  'invalid_auth',
  'missing_scope',
  'not_allowed_token_type',
  'account_inactive',
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'user_not_found',
  'already_reacted',
  'invalid_name',
  'no_permission',
  'access_denied',
  'restricted_action',
  'ratelimited',
  'msg_too_long',
  'thread_not_found',
]);
export class SlackApiError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode?: string,
    readonly retryAfterMs?: number,
  ) {
    super('Slack request failed');
  }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid Slack response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const signal = callSignal();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  try {
    signal?.throwIfAborted();
    signal?.addEventListener('abort', cancel, { once: true });
    while (true) {
      callSignal()?.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Slack response exceeds size limit');
      chunks.push(part.value);
    }
    callSignal()?.throwIfAborted();
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).ok !== 'boolean'
    )
      throw new Error('Invalid Slack response');
    return value as Record<string, unknown>;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class SlackClient {
  constructor(private readonly token: string) {}
  async request(
    method: string,
    http: 'GET' | 'POST',
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!/^(?:xoxp-|xoxe\.xoxp-)[\x21-\x7e]+$/.test(this.token))
      throw new UpstreamCredentialInvalidError();
    if (!methods.has(method)) throw new Error('Unknown Slack operation');
    const url = new URL(`https://slack.com/api/${method}`);
    const params = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    if (http === 'GET')
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return withToolCallDeadline(20_000, async () => {
      const pacer = new RateLimitPacer({
        namespace: 'slack-web-api',
        maxAttempts: 3,
        retryStatuses: http === 'GET' ? [429, 500, 502, 503, 504] : [429],
        maxSingleWaitMs: 2000,
        totalWaitBudgetMs: 4000,
      });
      const { response, rateLimit } = await pacer.run(
        createHash('sha256').update(`${method}\0${this.token}`).digest('hex'),
        async () => {
          const raw = await safeFetch(url.toString(), {
            method: http,
            signal: callSignal(),
            redirect: 'error',
            maxRedirects: 0,
            allowPrivate: false,
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: 'application/json',
              ...(http === 'POST' ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
            },
            ...(http === 'POST' ? { body: JSON.stringify(params) } : {}),
          });
          if (!raw.ok) {
            await raw.body?.cancel();
            return { status: raw.status, headers: raw.headers, data: undefined };
          }
          const data = await json(raw);
          return {
            status: data.ok === false && data.error === 'ratelimited' ? 429 : raw.status,
            headers: raw.headers,
            data,
          };
        },
      );
      const retry =
        rateLimit?.nextWaitMs ?? parseRetryAfterMs(response.headers.get('retry-after'), Date.now());
      if (response.status === 429 || response.status < 200 || response.status >= 300)
        throw new SlackApiError(response.status, undefined, retry);
      const data = response.data!;
      if (data.ok === false) {
        if (data.error === 'token_revoked' || data.error === 'token_expired')
          throw new UpstreamCredentialInvalidError();
        throw new SlackApiError(
          response.status,
          typeof data.error === 'string' && safeReasons.has(data.error) ? data.error : undefined,
        );
      }
      return data;
    });
  }
}
