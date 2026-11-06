import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, MicrosoftTeamsServer, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const credential = (token = 'work-token') => ({
  apiKey: token,
  headerName: 'Authorization',
  headerValue: token,
});
const server = () => new MicrosoftTeamsServer(credential());
const body = { contentType: 'text', content: 'Synthetic message' };
const mentioned = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    displayName: 'Alex',
    userIdentityType: 'aadUser',
  },
};
it('advertises an organization-only per-user OAuth offer before connecting', () => {
  expect(endpoints.map((e) => [e.path, e.package.metadata.id, e.auth])).toEqual([
    ['/mcp', 'microsoft-teams', 'oauth'],
  ]);
  const auth = mcpPackage.metadata.oauthDefaults;
  expect(auth?.authorizationEndpoint).toBe(
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
  );
  expect(auth?.tokenEndpoint).toBe(
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
  );
  expect(auth?.scopes).toEqual([
    'User.Read',
    'offline_access',
    'Chat.ReadWrite',
    'ChannelMessage.Read.All',
    'ChannelMessage.Send',
    'Team.ReadBasic.All',
    'Channel.ReadBasic.All',
    'User.ReadBasic.All',
  ]);
});
it('exposes all required Teams operations and annotates reads', async () => {
  const tools = await server().listTools();
  expect(tools.map((t) => t.name)).toEqual([
    'teams_list_chats',
    'teams_list_chat_messages',
    'teams_send_chat_message',
    'teams_list_joined_teams',
    'teams_list_channels',
    'teams_list_channel_messages',
    'teams_list_replies',
    'teams_post_channel_message',
    'teams_reply_in_thread',
    'teams_search_users',
  ]);
  expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toHaveLength(7);
  expect(tools.filter((t) => t.annotations?.destructiveHint)).toHaveLength(0);
});
it.each([
  ['teams_list_chats', { top: 20, chatType: 'group' }, 'GET', 'me/chats', undefined],
  [
    'teams_list_chat_messages',
    { chatId: '19:chat@thread.v2', top: 30, before: '2026-11-06T12:00:00Z' },
    'GET',
    'chats/19%3Achat%40thread.v2/messages',
    undefined,
  ],
  ['teams_send_chat_message', { chatId: 'chat', body }, 'POST', 'chats/chat/messages', { body }],
  ['teams_list_joined_teams', {}, 'GET', 'me/joinedTeams', undefined],
  [
    'teams_list_channels',
    { teamId: 'team', membershipType: 'private' },
    'GET',
    'teams/team/channels',
    undefined,
  ],
  [
    'teams_list_channel_messages',
    { teamId: 'team', channelId: 'channel', top: 50 },
    'GET',
    'teams/team/channels/channel/messages',
    undefined,
  ],
  [
    'teams_list_replies',
    { teamId: 'team', channelId: 'channel', messageId: 'message', top: 20 },
    'GET',
    'teams/team/channels/channel/messages/message/replies',
    undefined,
  ],
  [
    'teams_post_channel_message',
    { teamId: 'team', channelId: 'channel', subject: 'Topic', body },
    'POST',
    'teams/team/channels/channel/messages',
    { body, subject: 'Topic' },
  ],
  [
    'teams_reply_in_thread',
    { teamId: 'team', channelId: 'channel', messageId: 'message', body },
    'POST',
    'teams/team/channels/channel/messages/message/replies',
    { body },
  ],
  ['teams_search_users', { query: "O'Neil", top: 10 }, 'GET', 'users', undefined],
] as const)('maps %s to the delegated Graph API', async (name, args, method, path, payload) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ value: [], id: 'created' }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool(name, args)).toMatchObject({
    structuredContent: { id: 'created' },
  });
  const [raw, init] = fetch.mock.calls[0]!;
  const url = new URL(String(raw));
  expect(url.origin).toBe('https://graph.microsoft.com');
  expect(url.pathname).toBe(`/v1.0/${path}`);
  expect(init?.method).toBe(method);
  expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(payload);
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer work-token');
  if (name === 'teams_list_joined_teams') expect(url.search).toBe('');
  if (name === 'teams_list_chat_messages') {
    expect(url.searchParams.get('$orderby')).toBe('lastModifiedDateTime desc');
    expect(url.searchParams.get('$filter')).toBe('lastModifiedDateTime lt 2026-11-06T12:00:00Z');
  }
  if (name === 'teams_search_users') {
    expect(url.searchParams.get('$filter')).toBe(
      "startswith(displayName,'O''Neil') or startswith(mail,'O''Neil') or startswith(userPrincipalName,'O''Neil')",
    );
    expect(url.searchParams.get('$select')).toBe('id,displayName,mail,userPrincipalName');
  }
});
it('sends a user mention without dropping Graph identities or HTML tags', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: 'sent' }));
  vi.stubGlobal('fetch', fetch);
  const message = {
    body: { contentType: 'html', content: 'Hello <at id="0">Alex</at>' },
    mentions: [{ id: 0, mentionText: 'Alex', mentioned }],
  };
  expect(
    await server().callTool('teams_send_chat_message', { chatId: 'chat', ...message }),
  ).toMatchObject({ structuredContent: { id: 'sent' } });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(message);
});
it('refuses malformed mentions, resource traversal and unsupported Graph query combinations', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const [name, args] of [
    [
      'teams_send_chat_message',
      {
        chatId: 'chat',
        body: { contentType: 'text', content: 'Hello' },
        mentions: [{ id: 0, mentionText: 'Alex', mentioned }],
      },
    ],
    [
      'teams_send_chat_message',
      {
        chatId: 'chat',
        body: { contentType: 'html', content: '<at id="1">Alex</at>' },
        mentions: [{ id: 0, mentionText: 'Alex', mentioned }],
      },
    ],
    [
      'teams_send_chat_message',
      {
        chatId: 'chat',
        body: { contentType: 'html', content: '<at id="0">Alex</at>' },
        mentions: [
          { id: 0, mentionText: 'Alex', mentioned },
          { id: 0, mentionText: 'Alex', mentioned },
        ],
      },
    ],
    ['teams_list_channels', { teamId: '..' }],
    ['teams_list_chats', { top: 51 }],
    ['teams_list_joined_teams', { top: 10 }],
    [
      'teams_list_chat_messages',
      { chatId: 'chat', orderBy: 'createdDateTime', after: '2026-11-06T00:00:00Z' },
    ],
    ['teams_search_users', { query: '', accessToken: 'secret' }],
  ] as const)
    expect(await server().callTool(name, args)).toHaveProperty('isError', true);
  expect(fetch).not.toHaveBeenCalled();
});
it('follows only the same collection and normalizes equivalent encoded resource IDs', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ value: [], '@odata.nextLink': 'next' }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    await server().callTool('teams_list_chat_messages', {
      chatId: '19:chat@thread.v2',
      nextLink: 'https://graph.microsoft.com/v1.0/chats/19:chat@thread.v2/messages?$skiptoken=next',
    }),
  ).toHaveProperty('structuredContent');
  expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('$skiptoken')).toBe('next');
  for (const nextLink of [
    'https://evil.test/v1.0/chats/19:chat@thread.v2/messages',
    'https://graph.microsoft.com/v1.0/chats/other/messages',
    'https://graph.microsoft.com/v1.0/users',
    'http://graph.microsoft.com/v1.0/chats/19:chat@thread.v2/messages',
  ])
    expect(
      await server().callTool('teams_list_chat_messages', {
        chatId: '19:chat@thread.v2',
        nextLink,
      }),
    ).toHaveProperty('isError', true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('keeps simultaneous accounts isolated and never reflects provider errors', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    Response.json({ owner: new Headers(init?.headers).get('authorization') }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    await Promise.all(
      ['one', 'two'].map((token) =>
        new MicrosoftTeamsServer(credential(token)).callTool('teams_list_chats', {}),
      ),
    ),
  ).toMatchObject([
    { structuredContent: { owner: 'Bearer one' } },
    { structuredContent: { owner: 'Bearer two' } },
  ]);
  fetch.mockImplementation(
    async () => new Response('work-token private-provider-data', { status: 403 }),
  );
  const result = await server().callTool('teams_list_chats', {});
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'PROVIDER_ERROR', status: 403 } },
  });
  expect(JSON.stringify(result)).not.toContain('private-provider-data');
  fetch.mockImplementation(
    async () => new Response('work-token private-provider-data', { status: 401 }),
  );
  await expect(server().callTool('teams_list_chats', {})).rejects.toMatchObject({ code: -32050 });
});
