import { afterEach, expect, it, vi } from 'vitest';
import { GoogleGmailServer } from '../src/gmail.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
const message = {
  from: 'sender@example.test',
  to: ['recipient@example.test'],
  subject: 'Subject',
  text: 'Body',
  messageId: '<stable.123@example.test>',
  replyTo: 'reply@example.test',
  senderDisplayName: 'Žofie, Support',
};
const server = () =>
  new GoogleGmailServer({
    apiKey: 'user-token',
    headerName: 'Authorization',
    headerValue: 'user-token',
  });
it('preserves a supplied RFC Message-ID, encodes the From name and sets Reply-To', async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ id: 'sent' }));
  vi.stubGlobal('fetch', fetch);
  for (let i = 0; i < 2; i++) {
    expect(await server().callTool('gmail_send_message', message)).toMatchObject({
      structuredContent: { id: 'sent' },
    });
    const body = JSON.parse(fetch.mock.calls[i]![1].body);
    const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(mime).toContain('Message-ID: <stable.123@example.test>\r\n');
    expect(mime).toContain(
      `From: =?UTF-8?B?${Buffer.from(message.senderDisplayName).toString('base64')}?= <sender@example.test>\r\n`,
    );
    expect(mime).toContain('Reply-To: reply@example.test\r\n');
  }
});
it('preserves stable identity with all reply headers and the provider threadId', async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ id: 'sent' }));
  vi.stubGlobal('fetch', fetch);
  expect(
    await server().callTool('gmail_reply_message', {
      ...message,
      threadId: 'thread1',
      inReplyTo: '<parent@example.test>',
      references: ['<parent@example.test>'],
    }),
  ).toMatchObject({ structuredContent: { id: 'sent' } });
  const body = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(body.threadId).toBe('thread1');
  const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
  expect(mime).toContain('In-Reply-To: <parent@example.test>\r\nReferences: <parent@example.test>');
  expect(mime).toContain('Message-ID: <stable.123@example.test>');
});
it.each([
  { messageId: '<ok@example.test>\r\nBcc: victim@example.test' },
  { messageId: '<ok@example.test> in:anywhere' },
  { replyTo: 'Name <reply@example.test>' },
  { replyTo: 'bad' },
  { senderDisplayName: 'Name\r\nBcc: victim@example.test' },
  { headers: { 'X-Unvalidated': 'header' } },
])('refuses injected or arbitrary headers before dispatch: %#', async (extra) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool('gmail_send_message', { ...message, ...extra })).toMatchObject({
    structuredContent: { error: { code: 'INVALID_ARGUMENTS' } },
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('exports the validated MIME contract for a first-party host without a network request', async () => {
  const contract = await import('../src/index.js');
  const build = (
    contract as unknown as {
      buildGmailMessage: (input: unknown, reply?: boolean) => { raw: string; threadId?: string };
    }
  ).buildGmailMessage;
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const encoded = build(message);
  expect(Buffer.from(encoded.raw, 'base64url').toString('utf8')).toContain(
    'Message-ID: <stable.123@example.test>',
  );
  expect(encoded.threadId).toBeUndefined();
  expect(() => build({ ...message, headers: { From: 'unvalidated' } })).toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['<..@example.test>', '<id@..>', '<id@-example.test>', '<id@.example.test>'])(
  'rejects a malformed RFC Message-ID: %s',
  async (messageId) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await server().callTool('gmail_send_message', { ...message, messageId })).toMatchObject({
      structuredContent: { error: { code: 'INVALID_ARGUMENTS' } },
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);
