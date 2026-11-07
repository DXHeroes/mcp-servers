import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage, SlackServer } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const credential = (token = 'xoxp-user-one') => ({
  apiKey: token,
  headerName: 'Authorization',
  headerValue: token,
});
const server = () => new SlackServer(credential());
it('offers only a delegated user OAuth route with the required Slack scopes', () => {
  expect(endpoints.map((e) => [e.path, e.package.metadata.id, e.auth])).toEqual([
    ['/mcp', 'slack', 'oauth'],
  ]);
  expect(mcpPackage.metadata.oauthDefaults).toMatchObject({
    authorizationEndpoint: 'https://slack.com/oauth/v2_user/authorize',
    tokenEndpoint: 'https://slack.com/api/oauth.v2.user.access',
    noMetadata: true,
    scopes: [
      'channels:read',
      'channels:history',
      'groups:read',
      'groups:history',
      'im:read',
      'im:history',
      'users:read',
      'chat:write',
      'reactions:write',
      'search:read',
    ],
  });
});
it('exposes the complete bridge tool set with six reads and three writes', async () => {
  const tools = await server().listTools();
  expect(tools.map((t) => t.name)).toEqual([
    'slack_list_conversations',
    'slack_get_history',
    'slack_get_thread',
    'slack_search_messages',
    'slack_list_users',
    'slack_get_user',
    'slack_post_message',
    'slack_reply_in_thread',
    'slack_add_reaction',
  ]);
  expect(tools.filter((t) => t.annotations?.readOnlyHint)).toHaveLength(6);
  expect(tools.some((t) => t.annotations?.destructiveHint)).toBe(false);
});
it.each([
  [
    'slack_list_conversations',
    { types: ['private_channel', 'im'], cursor: 'opaque+/=', limit: 25, exclude_archived: true },
    'conversations.list',
    'GET',
    { types: 'private_channel,im', cursor: 'opaque+/=', limit: '25', exclude_archived: 'true' },
  ],
  [
    'slack_get_history',
    {
      channel: 'C123',
      oldest: '1700000000.000001',
      latest: '1700000001.000001',
      inclusive: true,
      cursor: 'next/+=',
      limit: 20,
    },
    'conversations.history',
    'GET',
    {
      channel: 'C123',
      oldest: '1700000000.000001',
      latest: '1700000001.000001',
      inclusive: 'true',
      cursor: 'next/+=',
      limit: '20',
    },
  ],
  [
    'slack_get_thread',
    { channel: 'D123', ts: '1700000000.123456', cursor: 'thread=', limit: 30 },
    'conversations.replies',
    'GET',
    { channel: 'D123', ts: '1700000000.123456', cursor: 'thread=', limit: '30' },
  ],
  [
    'slack_search_messages',
    {
      query: 'in:general from:<@U123> release',
      count: 50,
      page: 2,
      sort: 'timestamp',
      sort_dir: 'desc',
    },
    'search.messages',
    'GET',
    {
      query: 'in:general from:<@U123> release',
      count: '50',
      page: '2',
      sort: 'timestamp',
      sort_dir: 'desc',
    },
  ],
  [
    'slack_list_users',
    { cursor: 'users=', limit: 20 },
    'users.list',
    'GET',
    { cursor: 'users=', limit: '20' },
  ],
  ['slack_get_user', { user: 'U123' }, 'users.info', 'GET', { user: 'U123' }],
  [
    'slack_post_message',
    { channel: 'C123', text: 'Fixture <@U123>', mrkdwn: false },
    'chat.postMessage',
    'POST',
    {
      channel: 'C123',
      text: 'Fixture <@U123>',
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
      parse: 'none',
    },
  ],
  [
    'slack_reply_in_thread',
    { channel: 'G123', thread_ts: '1700000000.123456', text: 'Reply', reply_broadcast: true },
    'chat.postMessage',
    'POST',
    {
      channel: 'G123',
      thread_ts: '1700000000.123456',
      text: 'Reply',
      reply_broadcast: true,
      unfurl_links: false,
      unfurl_media: false,
      parse: 'none',
    },
  ],
  [
    'slack_add_reaction',
    { channel: 'C123', timestamp: '1700000000.123456', name: 'thumbsup::skin-tone-6' },
    'reactions.add',
    'POST',
    { channel: 'C123', timestamp: '1700000000.123456', name: 'thumbsup::skin-tone-6' },
  ],
] as const)(
  '%s preserves the provider operation and pagination',
  async (name, args, method, http, expected) => {
    const provider = {
      ok: true,
      messages: [{ type: 'message', text: 'Fixture', ts: '1700000000.123456' }],
      response_metadata: { next_cursor: 'second/+= ' },
    };
    const fetch = vi.fn(async () => Response.json(provider));
    vi.stubGlobal('fetch', fetch);
    const result = await server().callTool(name, args);
    expect(result).toMatchObject({ structuredContent: provider });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(input);
    expect(url.origin + url.pathname).toBe(`https://slack.com/api/${method}`);
    expect(init.method).toBe(http);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer xoxp-user-one');
    expect(
      http === 'GET' ? Object.fromEntries(url.searchParams) : JSON.parse(String(init.body)),
    ).toMatchObject(expected);
    expect(url.searchParams.has('token')).toBe(false);
  },
);
it('keeps default list sizes finite and defaults to channels and one-to-one DMs', async () => {
  const seen: URL[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    seen.push(new URL(input));
    return Response.json({ ok: true, channels: [] });
  });
  await server().callTool('slack_list_conversations', {});
  await server().callTool('slack_get_history', { channel: 'C123' });
  expect(Object.fromEntries(seen[0]!.searchParams)).toMatchObject({
    types: 'public_channel,private_channel,im',
    limit: '100',
  });
  expect(seen[1]!.searchParams.get('limit')).toBe('100');
});
it('rejects invalid identities, reversed ranges, unsafe pagination and unsupported payloads before dispatch', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const [name, args] of [
    ['slack_get_history', { channel: '../../other' }],
    [
      'slack_get_history',
      { channel: 'C123', oldest: '9007199254740991.000002', latest: '9007199254740991.000001' },
    ],
    ['slack_list_conversations', { types: ['mpim'] }],
    ['slack_get_thread', { channel: 'C123', ts: '1.000000', nextLink: 'https://other.example' }],
    ['slack_search_messages', { query: 'x', page: 101 }],
    ['slack_get_user', { user: 'https://evil.example' }],
    ['slack_post_message', { channel: 'C123', text: 'x'.repeat(4001) }],
    ['slack_reply_in_thread', { channel: 'C123', text: 'no parent' }],
    ['slack_add_reaction', { channel: 'C123', timestamp: '1.000000', name: ':thumbsup:' }],
    ['slack_list_users', { limit: 201 }],
  ] as const)
    expect(await server().callTool(name, args)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_ARGUMENTS' } },
    });
  expect(fetch).not.toHaveBeenCalled();
});
it('isolates simultaneous user tokens and rejects known bot credentials without provider dispatch', async () => {
  const seen: string[] = [];
  const fetch = vi.fn(async (_: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization')!);
    return Response.json({ ok: true, channels: [] });
  });
  vi.stubGlobal('fetch', fetch);
  await Promise.all(
    ['xoxp-user-one', 'xoxp-user-two'].map((t) =>
      new SlackServer(credential(t)).callTool('slack_list_conversations', {}),
    ),
  );
  expect(seen.sort()).toEqual(['Bearer xoxp-user-one', 'Bearer xoxp-user-two']);
  await expect(
    new SlackServer(credential('xoxb-bot')).callTool('slack_list_conversations', {}),
  ).rejects.toMatchObject({
    code: -32050,
    data: { 'io.dxheroes.connector/error': { version: 1, reason: 'upstream_credential_invalid' } },
  });
  await expect(
    new SlackServer(null).callTool('slack_list_conversations', {}),
  ).rejects.toMatchObject({
    code: -32050,
    data: { 'io.dxheroes.connector/error': { version: 1, reason: 'upstream_credential_invalid' } },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each(['token_revoked', 'token_expired'])(
  'signals the definite %s refusal even at HTTP 200',
  async (error) => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ ok: false, error, extra: 'private-provider-details' }),
    );
    await expect(server().callTool('slack_list_conversations', {})).rejects.toMatchObject({
      code: -32050,
      data: {
        'io.dxheroes.connector/error': { version: 1, reason: 'upstream_credential_invalid' },
      },
    });
  },
);
it.each([
  'invalid_auth',
  'missing_scope',
  'not_allowed_token_type',
  'account_inactive',
  'channel_not_found',
  'private-provider-details',
])('does not turn ambiguous or permission failure %s into reconnect', async (error) => {
  vi.stubGlobal('fetch', async () =>
    Response.json({ ok: false, error, needed: 'private-details', provided: 'private-details' }),
  );
  const result = await server().callTool('slack_list_conversations', {});
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'PROVIDER_ERROR' } },
  });
  expect(JSON.stringify(result)).not.toContain('private-');
});
it('returns provider permission and throttle status safely instead of empty success', async () => {
  for (const status of [403, 429]) {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('private-provider-details', { status, headers: { 'retry-after': '60' } }),
    );
    const result = await server().callTool('slack_list_conversations', {});
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { status, code: status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-provider');
  }
});
