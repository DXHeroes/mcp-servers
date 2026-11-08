import { afterEach, expect, it, vi } from 'vitest';
import { GoogleGmailServer } from '../src/gmail.js';
import { gmailPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
const server = (token = 'personal-token') =>
  new GoogleGmailServer({
    apiKey: token,
    headerName: 'Authorization',
    headerValue: token,
  });
const message = {
  from: 'sender@example.test',
  to: ['recipient@example.test'],
  subject: 'Fixture subject',
  text: 'Synthetic plain text',
};
function sentBody(fetch: ReturnType<typeof vi.fn>) {
  const [url, init] = fetch.mock.calls[0]!;
  return { url: String(url), init, body: JSON.parse(init.body) };
}
it('offers only two non-idempotent sends with the sensitive send-only grant', async () => {
  expect(gmailPackage.metadata.id).toBe('google-gmail-send');
  expect(gmailPackage.metadata.oauthDefaults?.scopes).toEqual([
    'https://www.googleapis.com/auth/gmail.send',
  ]);
  const tools = await server().listTools();
  expect(tools.map((t) => t.name)).toEqual(['gmail_send_message', 'gmail_reply_message']);
  for (const tool of tools)
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
});
it('sends UTF-8 MIME with To/Cc/Bcc and both body alternatives without reading mail', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'sent', threadId: 'thread' }));
  vi.stubGlobal('fetch', fetch);
  expect(
    await server().callTool('gmail_send_message', {
      ...message,
      subject: 'Příliš žluťoučký kůň — '.repeat(5),
      cc: ['cc@example.test'],
      bcc: ['bcc@example.test'],
      html: '<p>Český text</p>',
    }),
  ).toMatchObject({ structuredContent: { id: 'sent', threadId: 'thread' } });
  const { url, init, body } = sentBody(fetch);
  expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer personal-token');
  expect(body).not.toHaveProperty('threadId');
  expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/);
  const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
  expect(mime).toContain(
    'To: recipient@example.test\r\nCc: cc@example.test\r\nBcc: bcc@example.test',
  );
  expect(mime).toContain('Content-Type: multipart/alternative;');
  expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
  expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
  expect(mime).toContain(Buffer.from('<p>Český text</p>').toString('base64'));
  const subjectHeader = mime.match(/Subject: ([\s\S]*?)\r\nDate:/)![1]!;
  const decoded = [...subjectHeader.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map((m) => Buffer.from(m[1]!, 'base64').toString('utf8'))
    .join('');
  expect(decoded).toBe('Příliš žluťoučký kůň — '.repeat(5));
  expect(mime.split('\r\n').every((line) => line.length < 998)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('builds binary attachments and RFC2231 UTF-8 filenames under mixed/alternative MIME', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'sent' }));
  vi.stubGlobal('fetch', fetch);
  const bytes = Buffer.from([0, 255, 13, 10, 128, 1]);
  await server().callTool('gmail_send_message', {
    ...message,
    html: '<p>HTML</p>',
    attachments: [
      {
        filename: 'příloha.txt',
        contentType: 'application/octet-stream',
        contentBase64: bytes.toString('base64'),
      },
    ],
  });
  const mime = Buffer.from(sentBody(fetch).body.raw, 'base64url').toString('utf8');
  expect(mime).toContain('Content-Type: multipart/mixed;');
  expect(mime).toContain('Content-Type: multipart/alternative;');
  expect(mime).toContain("Content-Disposition: attachment;\r\n filename*0*=utf-8''");
  const encoded = [...mime.matchAll(/ filename\*\d+\*=(?:utf-8'')?([^;\r\n]+)/g)]
    .map((m) => m[1])
    .join('');
  expect(decodeURIComponent(encoded)).toBe('příloha.txt');
  expect(mime).toContain(bytes.toString('base64'));
});
it('sets all threading fields from the caller and never looks up the original mail', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'reply', threadId: 'abc123' }));
  vi.stubGlobal('fetch', fetch);
  expect(
    await server().callTool('gmail_reply_message', {
      ...message,
      threadId: 'abc123',
      inReplyTo: '<parent@example.test>',
      references: ['<root@example.test>', '<parent@example.test>'],
    }),
  ).toMatchObject({ structuredContent: { id: 'reply', threadId: 'abc123' } });
  const { body } = sentBody(fetch);
  expect(body.threadId).toBe('abc123');
  const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
  expect(mime).toContain(
    'In-Reply-To: <parent@example.test>\r\nReferences: <root@example.test>\r\n <parent@example.test>',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  { ...message, subject: 'subject\r\nBcc: victim@example.test' },
  { ...message, from: 'sender@example.test\r\nBcc: victim@example.test' },
  { ...message, bcc: ['victim@example.test\r\nX-Test: header'] },
  { ...message, to: [], cc: [], bcc: [] },
  { ...message, text: undefined },
  { ...message, raw: 'unvalidated MIME' },
  { ...message, threadId: 'abc123' },
  {
    ...message,
    attachments: [{ filename: 'a\nX: b', contentType: 'text/plain', contentBase64: 'YQ==' }],
  },
  {
    ...message,
    attachments: [{ filename: 'a', contentType: 'text/plain\r\nX: header', contentBase64: 'YQ==' }],
  },
  {
    ...message,
    attachments: [{ filename: 'a', contentType: 'text/plain', contentBase64: 'YR==' }],
  },
  { ...message, text: 'é'.repeat(600000) },
])('refuses invalid message input before any upstream send: %#', async (args) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool('gmail_send_message', args)).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'INVALID_ARGUMENTS' } },
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  {
    ...message,
    threadId: 'abc123',
    inReplyTo: 'gmail-api-id',
    references: ['<parent@example.test>'],
  },
  {
    ...message,
    threadId: 'abc123',
    inReplyTo: '<parent@example.test>',
    references: ['<wrong@example.test>'],
  },
  {
    ...message,
    threadId: '../other',
    inReplyTo: '<parent@example.test>',
    references: ['<parent@example.test>'],
  },
  {
    ...message,
    threadId: 'abc123',
    inReplyTo: '<parent@example.test>\r\nBcc: x@example.test',
    references: [],
  },
])('refuses incomplete or injected threading headers: %#', async (args) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool('gmail_reply_message', args)).toHaveProperty('isError', true);
  expect(fetch).not.toHaveBeenCalled();
});
it('requires the upstream credential and only maps definite 401 to reconnect', async () => {
  await expect(
    new GoogleGmailServer(null).callTool('gmail_send_message', message),
  ).rejects.toMatchObject({ code: -32050 });
  const fetch = vi
    .fn()
    .mockImplementation(async () => new Response('private token', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  await expect(server().callTool('gmail_send_message', message)).rejects.toMatchObject({
    code: -32050,
  });
  fetch.mockImplementation(async () => new Response('private token', { status: 403 }));
  const result = await server().callTool('gmail_send_message', message);
  expect(result).toMatchObject({
    structuredContent: { error: { code: 'PROVIDER_ERROR', status: 403 } },
  });
  expect(JSON.stringify(result)).not.toContain('private token');
});
it('does not replay an uncertain send; retries only a definite short throttle', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('private outcome unknown'));
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool('gmail_send_message', message)).toHaveProperty('isError', true);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockReset().mockImplementation(async () => new Response(null, { status: 503 }));
  expect(await server().callTool('gmail_send_message', message)).toHaveProperty('isError', true);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch
    .mockReset()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '0' } }))
    .mockResolvedValueOnce(Response.json({ id: 'sent' }));
  expect(await server().callTool('gmail_send_message', message)).toMatchObject({
    structuredContent: { id: 'sent' },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('honors cancellation before any dispatch and refuses unknown tools', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const c = new AbortController();
  c.abort();
  expect(
    await server().callTool('gmail_send_message', message, { signal: c.signal }),
  ).toHaveProperty('isError', true);
  expect(await server().callTool('gmail_read_message', message)).toMatchObject({
    structuredContent: { error: { code: 'UNKNOWN_TOOL' } },
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['cc', 'bcc'] as const)(
  'allows %s-only delivery without adding a visible To recipient',
  async (field) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'sent' }));
    vi.stubGlobal('fetch', fetch);
    expect(
      await server().callTool('gmail_send_message', {
        ...message,
        to: [],
        [field]: ['recipient@example.test'],
        text: undefined,
        html: '<p>HTML only</p>',
      }),
    ).toMatchObject({ structuredContent: { id: 'sent' } });
    const mime = Buffer.from(sentBody(fetch).body.raw, 'base64url').toString('utf8');
    expect(mime).not.toContain('\r\nTo:');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
  },
);
it('bounds the combined decoded payload, not just each individual part', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const attachment = {
    filename: 'a.txt',
    contentType: 'text/plain',
    contentBase64: Buffer.alloc(600000).toString('base64'),
  };
  expect(
    await server().callTool('gmail_send_message', {
      ...message,
      attachments: [attachment, attachment],
    }),
  ).toHaveProperty('isError', true);
  expect(
    await server().callTool('gmail_send_message', {
      ...message,
      cc: Array(100).fill('x@example.test'),
    }),
  ).toHaveProperty('isError', true);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([{}, { id: '' }, { id: 42 }])(
  'returns unknown outcome for an incomplete success body: %#',
  async (body) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal('fetch', fetch);
    expect(await server().callTool('gmail_send_message', message)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'SEND_OUTCOME_UNKNOWN' } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it('reports long throttles without waiting or exposing provider details', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response('private provider data', {
      status: 429,
      headers: { 'Retry-After': '60' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const result = await server().callTool('gmail_send_message', message);
  expect(result).toMatchObject({
    structuredContent: { error: { code: 'RATE_LIMITED', status: 429, retryAfterMs: 60000 } },
  });
  expect(JSON.stringify(result)).not.toContain('private provider data');
  expect(fetch).toHaveBeenCalledTimes(1);
});
