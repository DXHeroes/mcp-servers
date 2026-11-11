import { afterEach, expect, it, vi } from 'vitest';
import { GoogleGmailServer } from '../src/gmail.js';
import * as google from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
const ReadServer = (google as unknown as { GoogleGmailReadServer: typeof GoogleGmailServer })
  .GoogleGmailReadServer;
const server = (token = 'user-token') =>
  new ReadServer({ apiKey: token, headerName: 'Authorization', headerValue: token });
const profile = { emailAddress: 'reader@example.test', historyId: '100' };
const message = (id = 'm1', text = 'Žlutý text') => ({
  id,
  threadId: 't1',
  historyId: '10',
  labelIds: ['INBOX'],
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'Message-ID', value: `<${id}@example.test>` },
      { name: 'Subject', value: 'Synthetic subject' },
    ],
    parts: [
      {
        partId: '0',
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
        body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') },
      },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'fixture.pdf',
        body: { size: 4, attachmentId: 'a1' },
      },
    ],
  },
});
function provider(body: unknown) {
  const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    if (String(url).endsWith('/profile')) return Response.json(profile);
    const requestUrl = new URL(url);
    const fields = requestUrl.searchParams.get('fields') ?? '';
    if (requestUrl.searchParams.get('format') === 'minimal') {
      const thread = body as { id: string; messages?: { id: string; threadId: string }[] };
      return Response.json({
        id: thread.id,
        messages: thread.messages?.map((m) => ({ id: m.id, threadId: m.threadId })),
      });
    }
    return Response.json(
      fields.includes('body(size,attachmentId)')
        ? JSON.parse(
            JSON.stringify(body, (key, value: unknown) => (key === 'data' ? undefined : value)),
          )
        : body,
    );
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const data = (result: unknown) =>
  (result as { structuredContent: Record<string, unknown> }).structuredContent;
it('publishes a separate readonly offer and never exposes sending', async () => {
  expect(ReadServer).toBeTypeOf('function');
  const endpoint = google.endpoints.find((e) => e.path === '/gmail-read/mcp');
  expect(endpoint?.package.metadata).toMatchObject({
    id: 'google-gmail-read',
    oauthDefaults: { scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  });
  const tools = await server().listTools();
  expect(tools.map((t) => t.name)).toEqual([
    'gmail_list_messages',
    'gmail_get_message',
    'gmail_get_thread',
    'gmail_find_sent_message',
    'gmail_get_attachment',
  ]);
  expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  const fetch = provider({});
  expect(await server().callTool('gmail_send_message', {})).toMatchObject({
    structuredContent: { error: { code: 'UNKNOWN_TOOL' } },
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('proves mailbox identity from the same token and preserves explicit provider pagination', async () => {
  const fetch = provider({
    messages: [{ id: 'm1', threadId: 't1' }],
    nextPageToken: 'next-page',
    resultSizeEstimate: 2,
  });
  expect(
    await server().callTool('gmail_list_messages', {
      q: 'is:unread',
      maxResults: 1,
      pageToken: 'previous',
    }),
  ).toMatchObject({
    structuredContent: {
      mailbox: { emailAddress: profile.emailAddress, verified: true, source: 'users.getProfile' },
      messages: [{ id: 'm1', threadId: 't1' }],
      complete: false,
      nextPageToken: 'next-page',
    },
  });
  const url = new URL(fetch.mock.calls[1]![0]);
  expect(url.searchParams.get('pageToken')).toBe('previous');
  expect(url.searchParams.get('maxResults')).toBe('1');
  expect(url.searchParams.get('q')).toBe('is:unread');
  expect(
    fetch.mock.calls.every(
      (c) => new Headers(c[1].headers).get('authorization') === 'Bearer user-token',
    ),
  ).toBe(true);
});
it('refuses missing or invalid profile proof without reading a message', async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ emailAddress: 'invalid' }));
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'INVALID_PROVIDER_RESPONSE' } },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('decodes text and preserves headers after a metadata-only preflight', async () => {
  const body = message();
  body.payload.parts.pop();
  const fetch = provider(body);
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    structuredContent: {
      complete: true,
      nextCursor: null,
      message: {
        id: 'm1',
        headers: [
          { name: 'Message-ID', value: '<m1@example.test>' },
          { name: 'Subject', value: 'Synthetic subject' },
        ],
        parts: [{ partId: '0', text: 'Žlutý text', complete: true }],
      },
    },
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('pages a long body without silent truncation and rejects a changed message snapshot', async () => {
  const body = message('m1', 'Žlutý text'.repeat(200));
  body.payload.parts.pop();
  const fetch = provider(body);
  const first = data(
    await server().callTool('gmail_get_message', { id: 'm1', maxBodyChars: 1000 }),
  );
  expect(first.complete).toBe(false);
  expect(first.nextCursor).toBeTypeOf('string');
  const second = data(
    await server().callTool('gmail_get_message', {
      id: 'm1',
      maxBodyChars: 1000,
      cursor: first.nextCursor,
    }),
  );
  expect(second.complete).toBe(true);
  const parts = (d: Record<string, unknown>) =>
    (d.message as { parts: { text?: string }[] }).parts.map((p) => p.text ?? '').join('');
  expect(parts(first) + parts(second)).toBe('Žlutý text'.repeat(200));
  fetch.mockImplementation(async (url: string) =>
    Response.json(url.endsWith('/profile') ? profile : message('m1', 'changed')),
  );
  expect(
    await server().callTool('gmail_get_message', { id: 'm1', cursor: first.nextCursor }),
  ).toMatchObject({ structuredContent: { error: { code: 'STALE_CURSOR' } } });
});
it('pages all thread messages with a snapshot-bound cursor and marks deferred message bodies', async () => {
  provider({
    id: 't1',
    historyId: '101',
    messages: [message('m1'), message('m2'), message('m3', 'x'.repeat(2000))],
  });
  const first = data(
    await server().callTool('gmail_get_thread', { id: 't1', maxResults: 2, maxBodyChars: 1000 }),
  );
  expect(first).toMatchObject({
    complete: false,
    totalMessages: 3,
    messages: [{ id: 'm1' }, { id: 'm2' }],
  });
  const second = data(
    await server().callTool('gmail_get_thread', {
      id: 't1',
      maxResults: 2,
      maxBodyChars: 1000,
      cursor: first.nextCursor,
    }),
  );
  expect(second).toMatchObject({
    complete: false,
    nextCursor: null,
    messages: [
      {
        id: 'm3',
        complete: false,
        bodyReference: { tool: 'gmail_get_message', arguments: { id: 'm3' } },
      },
    ],
  });
});
it('constructs only the sent RFC Message-ID search and exposes ambiguous pagination', async () => {
  const fetch = provider({ messages: [{ id: 'sent', threadId: 't1' }], nextPageToken: 'next' });
  expect(
    await server().callTool('gmail_find_sent_message', {
      messageId: '<stable.123@example.test>',
      maxResults: 2,
    }),
  ).toMatchObject({
    structuredContent: { complete: false, nextPageToken: 'next', messages: [{ id: 'sent' }] },
  });
  const url = new URL(fetch.mock.calls[1]![0]);
  expect(url.searchParams.get('q')).toBe('in:sent rfc822msgid:<stable.123@example.test>');
});
it.each([
  { messageId: '<ok@example.test> OR in:anywhere' },
  { messageId: '<ok@example.test>\r\nX: y' },
  { messageId: 'opaque-id' },
  { messageId: '<ok@example.test>', q: 'in:anywhere' },
])('refuses an unbounded sent query: %#', async (args) => {
  const fetch = provider({});
  expect(await server().callTool('gmail_find_sent_message', args)).toMatchObject({
    structuredContent: { error: { code: 'INVALID_ARGUMENTS' } },
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('downloads attachment bytes only explicitly and enforces the caller size cap', async () => {
  const fetch = provider({ size: 4, data: Buffer.from('data').toString('base64url') });
  expect(
    await server().callTool('gmail_get_attachment', {
      messageId: 'm1',
      attachmentId: 'a1',
      maxBytes: 4,
    }),
  ).toMatchObject({ structuredContent: { complete: true, size: 4, contentBase64: 'ZGF0YQ==' } });
  expect(new URL(fetch.mock.calls[1]![0]).pathname.endsWith('/messages/m1/attachments/a1')).toBe(
    true,
  );
  expect(
    await server().callTool('gmail_get_attachment', {
      messageId: 'm1',
      attachmentId: 'a1',
      maxBytes: 3,
    }),
  ).toMatchObject({ structuredContent: { error: { code: 'ATTACHMENT_TOO_LARGE' } } });
});
it('maps read provider failures without leaking response bodies or credentials', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('secret', { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  const result = await server().callTool('gmail_list_messages', {});
  expect(result).toMatchObject({
    structuredContent: { error: { code: 'PROVIDER_ERROR', status: 403 } },
  });
  expect(JSON.stringify(result)).not.toContain('secret');
  fetch.mockImplementation(async () => new Response('secret', { status: 401 }));
  await expect(server().callTool('gmail_list_messages', {})).rejects.toMatchObject({
    code: -32050,
  });
});
it('rejects malformed MIME data rather than claiming complete content', async () => {
  const body = message();
  body.payload.parts[0]!.body.data = '%%%';
  body.payload.parts.pop();
  provider(body);
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    structuredContent: { error: { code: 'INVALID_PROVIDER_RESPONSE' } },
  });
});
it('rejects invalid IDs, cursors and cancellation before provider access', async () => {
  const fetch = provider({});
  const controller = new AbortController();
  controller.abort();
  for (const args of [{ id: '../escape' }, { id: 'm1', cursor: 'invalid' }])
    expect(await server().callTool('gmail_get_message', args)).toHaveProperty('isError', true);
  expect(
    await server().callTool('gmail_list_messages', {}, { signal: controller.signal }),
  ).toHaveProperty('isError', true);
  expect(fetch).not.toHaveBeenCalled();
});
it('makes inline attachment bytes available only through the explicit bounded operation', async () => {
  const body = message();
  body.payload.parts[1]!.body = { size: 4, data: Buffer.from('data').toString('base64url') };
  const fetch = provider(body);
  const read = await server().callTool('gmail_get_message', { id: 'm1' });
  expect(JSON.stringify(read)).not.toContain('ZGF0YQ');
  expect(
    await server().callTool('gmail_get_attachment', { messageId: 'm1', partId: '1', maxBytes: 4 }),
  ).toMatchObject({ structuredContent: { contentBase64: 'ZGF0YQ==', size: 4, complete: true } });
  expect(fetch.mock.calls.every((c) => !String(c[0]).includes('/attachments/'))).toBe(true);
});
it('binds cursors to mailbox, resource and thread snapshot', async () => {
  const fetch = provider({ id: 't1', messages: [message('m1'), message('m2')] });
  const first = data(await server().callTool('gmail_get_thread', { id: 't1', maxResults: 1 }));
  fetch.mockImplementation(async (url: string) =>
    Response.json(
      url.endsWith('/profile')
        ? { emailAddress: 'other@example.test' }
        : { id: 't1', messages: [message('m1'), message('m2')] },
    ),
  );
  expect(
    await server('other-token').callTool('gmail_get_thread', {
      id: 't1',
      cursor: first.nextCursor,
    }),
  ).toMatchObject({ structuredContent: { error: { code: 'STALE_CURSOR' } } });
  fetch.mockImplementation(async (url: string) =>
    Response.json(
      url.endsWith('/profile')
        ? profile
        : { id: 't1', messages: [message('m1'), message('m2'), message('m3')] },
    ),
  );
  expect(
    await server().callTool('gmail_get_thread', { id: 't1', cursor: first.nextCursor }),
  ).toMatchObject({ structuredContent: { error: { code: 'STALE_CURSOR' } } });
});
it('uses bounded message references for a thread larger than the full-response cap', async () => {
  provider({ id: 't1', messages: [message('m1', 'x'.repeat(2 * 1024 * 1024))] });
  expect(await server().callTool('gmail_get_thread', { id: 't1' })).toMatchObject({
    structuredContent: {
      complete: false,
      messages: [
        { id: 'm1', bodyReference: { tool: 'gmail_get_message', arguments: { id: 'm1' } } },
      ],
    },
  });
});
it('decodes declared legacy charsets', async () => {
  const body = message();
  body.payload.parts[0]!.headers![0]!.value = 'text/plain; charset=windows-1252';
  body.payload.parts[0]!.body.data = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url');
  body.payload.parts[0]!.body.size = 4;
  body.payload.parts.pop();
  provider(body);
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    structuredContent: { message: { parts: [{ text: 'café' }] } },
  });
});
it('refuses a body whose declared decoded size disagrees with the delivered bytes', async () => {
  const body = message();
  body.payload.parts[0]!.body.size = 9000;
  body.payload.parts.pop();
  provider(body);
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    structuredContent: { error: { code: 'INVALID_PROVIDER_RESPONSE' } },
  });
});
