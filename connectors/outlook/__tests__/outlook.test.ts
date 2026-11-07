import { afterEach, expect, it, vi } from 'vitest';
import { OutlookCalendarServer } from '../src/calendar.js';
import { endpoints } from '../src/index.js';
import { OutlookMailServer } from '../src/mail.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
const credential = (token = 'personal-token') => ({
  apiKey: token,
  headerName: 'Authorization',
  headerValue: token,
});
const mail = () => new OutlookMailServer(credential());
const calendar = () => new OutlookCalendarServer(credential());
const response = (data: unknown) => new Response(JSON.stringify(data));
const range = { startDateTime: '2026-11-06T00:00:00Z', endDateTime: '2026-11-07T00:00:00Z' };
const message = {
  subject: 'Hello',
  body: { contentType: 'Text', content: 'Hello there' },
  toRecipients: [{ emailAddress: { address: 'recipient@example.test' } }],
};
it('publishes independent OAuth offers covering both account populations', () => {
  expect(endpoints.map((e) => [e.path, e.package.metadata.id, e.auth])).toEqual([
    ['/mail/mcp', 'outlook-mail', 'oauth'],
    ['/calendar/mcp', 'outlook-calendar', 'oauth'],
  ]);
  for (const endpoint of endpoints) {
    expect(endpoint.package.metadata.oauthDefaults?.authorizationEndpoint).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(endpoint.package.metadata.oauthDefaults?.scopes).toContain('offline_access');
  }
});
it('exposes the complete mail and calendar operation sets with read and delete annotations', async () => {
  const names = (await mail().listTools()).map((t) => t.name);
  expect(names).toEqual([
    'mail_search_messages',
    'mail_get_message',
    'mail_get_conversation',
    'mail_list_folders',
    'mail_create_draft',
    'mail_update_draft',
    'mail_send_draft',
    'mail_send_message',
    'mail_reply',
    'mail_reply_all',
    'mail_forward',
    'mail_move_message',
    'mail_flag_message',
    'mail_mark_read',
  ]);
  const tools = await calendar().listTools();
  expect(tools.map((t) => t.name)).toEqual([
    'calendar_list_calendars',
    'calendar_list_events',
    'calendar_get_event',
    'calendar_create_event',
    'calendar_update_event',
    'calendar_delete_event',
    'calendar_respond_to_invitation',
    'calendar_get_free_busy',
  ]);
  expect(tools.find((t) => t.name === 'calendar_get_free_busy')?.annotations?.readOnlyHint).toBe(
    true,
  );
  expect(tools.find((t) => t.name === 'calendar_delete_event')?.annotations?.destructiveHint).toBe(
    true,
  );
});
it.each([
  [
    'mail_search_messages',
    { search: 'from:alice@example.test', top: 20 },
    'GET',
    'me/messages',
    undefined,
  ],
  ['mail_get_message', { messageId: 'm/id' }, 'GET', 'me/messages/m%2Fid', undefined],
  ['mail_get_conversation', { conversationId: "c'quoted" }, 'GET', 'me/messages', undefined],
  [
    'mail_list_folders',
    { parentFolderId: 'inbox', includeHiddenFolders: true },
    'GET',
    'me/mailFolders/inbox/childFolders',
    undefined,
  ],
  ['mail_create_draft', message, 'POST', 'me/messages', message],
  [
    'mail_update_draft',
    { messageId: 'draft', subject: 'Changed' },
    'PATCH',
    'me/messages/draft',
    { subject: 'Changed' },
  ],
  ['mail_send_draft', { messageId: 'draft' }, 'POST', 'me/messages/draft/send', undefined],
  ['mail_send_message', { message }, 'POST', 'me/sendMail', { message }],
  [
    'mail_reply',
    { messageId: 'm', comment: 'Thanks' },
    'POST',
    'me/messages/m/reply',
    { comment: 'Thanks' },
  ],
  [
    'mail_reply_all',
    { messageId: 'm', comment: 'Thanks all' },
    'POST',
    'me/messages/m/replyAll',
    { comment: 'Thanks all' },
  ],
  [
    'mail_forward',
    { messageId: 'm', toRecipients: message.toRecipients },
    'POST',
    'me/messages/m/forward',
    { toRecipients: message.toRecipients },
  ],
  [
    'mail_move_message',
    { messageId: 'm', destinationId: 'archive' },
    'POST',
    'me/messages/m/move',
    { destinationId: 'archive' },
  ],
  [
    'mail_flag_message',
    { messageId: 'm', flag: { flagStatus: 'flagged' } },
    'PATCH',
    'me/messages/m',
    { flag: { flagStatus: 'flagged' } },
  ],
  [
    'mail_mark_read',
    { messageId: 'm', isRead: false },
    'PATCH',
    'me/messages/m',
    { isRead: false },
  ],
] as const)(
  'maps %s to the delegated mailbox without losing fields',
  async (name, args, method, path, body) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({ id: 'result', value: [], '@odata.nextLink': 'next' }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await mail().callTool(name, args)).toMatchObject({
      structuredContent: { id: 'result' },
    });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/v1.0/${path}`);
    expect(init.method).toBe(method);
    expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer personal-token');
    if (name === 'mail_get_conversation')
      expect(new URL(url).searchParams.get('$filter')).toBe("conversationId eq 'c''quoted'");
  },
);
it.each([
  ['calendar_list_calendars', {}, 'GET', 'me/calendars', undefined],
  [
    'calendar_list_events',
    { ...range, calendarId: 'work' },
    'GET',
    'me/calendars/work/calendarView',
    undefined,
  ],
  ['calendar_get_event', { eventId: 'e' }, 'GET', 'me/events/e', undefined],
  [
    'calendar_create_event',
    {
      subject: 'Meeting',
      start: { dateTime: '2026-11-06T09:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-06T10:00:00', timeZone: 'UTC' },
    },
    'POST',
    'me/events',
    {
      subject: 'Meeting',
      start: { dateTime: '2026-11-06T09:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-06T10:00:00', timeZone: 'UTC' },
    },
  ],
  [
    'calendar_update_event',
    { eventId: 'e', subject: 'Changed' },
    'PATCH',
    'me/events/e',
    { subject: 'Changed' },
  ],
  ['calendar_delete_event', { eventId: 'e' }, 'DELETE', 'me/events/e', undefined],
  [
    'calendar_respond_to_invitation',
    { eventId: 'e', response: 'tentativelyAccept', sendResponse: false },
    'POST',
    'me/events/e/tentativelyAccept',
    { sendResponse: false },
  ],
] as const)('maps %s to Microsoft Graph', async (name, args, method, path, body) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ value: [] }));
  vi.stubGlobal('fetch', fetch);
  expect(await calendar().callTool(name, args)).not.toHaveProperty('isError', true);
  const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
  expect(new URL(url).pathname).toBe(`/v1.0/${path}`);
  expect(init.method).toBe(method);
  expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
});
it('returns successful empty send responses and isolates two accounts', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  for (const token of ['personal', 'work'])
    expect(
      await new OutlookMailServer(credential(token)).callTool('mail_send_message', { message }),
    ).toMatchObject({ structuredContent: { success: true } });
  expect(
    fetch.mock.calls.map((call) =>
      new Headers((call as unknown as [string, RequestInit])[1].headers).get('authorization'),
    ),
  ).toEqual(['Bearer personal', 'Bearer work']);
});
it('preserves Graph pagination, refuses cross-origin cursors and rebinds owner aliases to /me', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    response({
      value: [],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=20',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    await mail().callTool('mail_search_messages', {
      nextLink: 'https://graph.microsoft.com/v1.0/users/owner/messages?$skip=20',
    }),
  ).toMatchObject({ structuredContent: { '@odata.nextLink': expect.any(String) } });
  expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe('/v1.0/me/messages');
  for (const nextLink of [
    'https://evil.test/v1.0/me/messages',
    'https://graph.microsoft.com/v1.0/me/drive',
    'http://graph.microsoft.com/v1.0/me/messages',
  ])
    expect(await mail().callTool('mail_search_messages', { nextLink })).toHaveProperty(
      'isError',
      true,
    );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('maps only revoked credentials to reconnect and keeps provider bodies out of errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(
      async () => new Response('personal-token secret error', { status: 401 }),
    ),
  );
  await expect(mail().callTool('mail_get_message', { messageId: 'm' })).rejects.toMatchObject({
    code: -32050,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(
      async () => new Response('personal-token secret error', { status: 403 }),
    ),
  );
  const result = await mail().callTool('mail_get_message', { messageId: 'm' });
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'PROVIDER_ERROR', status: 403 } },
  });
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('rejects invalid and empty patches before provider requests', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const [name, args] of [
    ['mail_search_messages', { search: 'query', filter: 'isRead eq false' }],
    ['mail_update_draft', { messageId: 'd' }],
    ['mail_get_message', { messageId: '..' }],
    ['mail_send_message', { message: { subject: 'Missing recipient' } }],
    ['mail_get_message', { messageId: 'm', token: 'secret' }],
  ] as const)
    expect(await mail().callTool(name, args)).toHaveProperty('isError', true);
  expect(await calendar().callTool('calendar_update_event', { eventId: 'e' })).toHaveProperty(
    'isError',
    true,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('uses getSchedule for work accounts', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    response({ value: [{ scheduleId: 'me@example.test', scheduleItems: [] }] }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    await calendar().callTool('calendar_get_free_busy', {
      ...range,
      schedules: ['me@example.test'],
    }),
  ).toMatchObject({ structuredContent: { value: [{ scheduleId: 'me@example.test' }] } });
  expect(String(fetch.mock.calls[0]?.[0])).toBe(
    'https://graph.microsoft.com/v1.0/me/calendar/getSchedule',
  );
});
it('falls back to all calendarView pages only for the current account, ignoring cancelled and free events', async () => {
  const fetch = vi.fn(async (url: string) => {
    const p = new URL(url).pathname;
    if (p.endsWith('/getSchedule')) return new Response(null, { status: 400 });
    if (p === '/v1.0/me')
      return response({
        mail: 'personal@example.test',
        userPrincipalName: 'personal@example.test',
      });
    if (!new URL(url).searchParams.has('$skip'))
      return response({
        value: [
          { isCancelled: false, showAs: 'free' },
          { isCancelled: true, showAs: 'busy' },
          {
            showAs: 'busy',
            start: { dateTime: '2026-11-06T09:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-11-06T10:00:00', timeZone: 'UTC' },
          },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=1',
      });
    return response({
      value: [
        {
          showAs: 'tentative',
          start: { dateTime: '2026-11-06T11:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-11-06T12:00:00', timeZone: 'UTC' },
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetch);
  const result = await calendar().callTool('calendar_get_free_busy', {
    ...range,
    schedules: ['personal@example.test'],
  });
  expect(result).toMatchObject({
    structuredContent: {
      source: 'calendarView',
      scope: 'self',
      scheduleItems: [{ status: 'busy' }, { status: 'tentative' }],
    },
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('never claims other people are free when getSchedule is unsupported', async () => {
  const fetch = vi.fn(async (url: string) =>
    new URL(url).pathname.endsWith('/getSchedule')
      ? new Response(null, { status: 403 })
      : response({ mail: 'personal@example.test' }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    await calendar().callTool('calendar_get_free_busy', {
      ...range,
      schedules: ['other@example.test'],
    }),
  ).toHaveProperty('isError', true);
  expect(fetch).toHaveBeenCalledTimes(2);
});
