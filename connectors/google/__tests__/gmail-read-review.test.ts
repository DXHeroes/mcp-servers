import { afterEach, expect, it, vi } from 'vitest';
import { GoogleGmailReadServer } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
const server = () =>
  new GoogleGmailReadServer({
    apiKey: 'reader-token',
    headerName: 'Authorization',
    headerValue: 'reader-token',
  });
const profile = { emailAddress: 'reader@example.test' };
const text = (value: string, partId = '') => ({
  partId,
  mimeType: 'text/plain',
  filename: '',
  headers: [],
  body: { size: Buffer.byteLength(value), data: Buffer.from(value).toString('base64url') },
});
const message = (payload: unknown, id = 'm1') => ({ id, threadId: 't1', payload });
function withoutData(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => (key === 'data' ? undefined : item)),
  );
}
function install(body: Record<string, unknown>) {
  const fetch = vi.fn().mockImplementation(async (input: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    const url = new URL(input);
    if (url.pathname.endsWith('/profile')) return Response.json(profile);
    const fields = url.searchParams.get('fields') ?? '';
    if (url.searchParams.get('format') === 'minimal') {
      const refs = body.messages as { id: string; threadId: string }[] | undefined;
      return Response.json(
        refs
          ? { id: body.id, messages: refs.map((m) => ({ id: m.id, threadId: m.threadId })) }
          : { id: body.id, threadId: body.threadId },
      );
    }
    return Response.json(fields.includes('body(size,attachmentId)') ? withoutData(body) : body);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
it.each([false, true])(
  'keeps filename-less Content-Disposition attachments opaque, including inherited containers: %s',
  async (nested) => {
    const part = text('private attachment text', nested ? '1.0' : '1');
    const attachment = nested
      ? {
          partId: '1',
          mimeType: 'multipart/mixed',
          filename: '',
          headers: [{ name: 'Content-Disposition', value: 'attachment' }],
          parts: [part],
        }
      : { ...part, headers: [{ name: 'content-disposition', value: 'attachment; size=23' }] };
    const fetch = install(
      message({
        partId: '',
        mimeType: 'multipart/mixed',
        parts: [text('ordinary text', '0'), attachment],
      }),
    );
    const result = await server().callTool('gmail_get_message', { id: 'm1' });
    expect(result).not.toHaveProperty('isError');
    expect(JSON.stringify(result)).not.toContain('private attachment text');
    expect(JSON.stringify(result)).toContain('gmail_get_attachment');
    expect(
      fetch.mock.calls
        .filter((c) => !String(c[0]).endsWith('/profile'))
        .every((c) =>
          new URL(c[0]).searchParams.get('fields')?.includes('body(size,attachmentId)'),
        ),
    ).toBe(true);
  },
);
it.each([{}, { success: true }, { unexpected: true }, { resultSizeEstimate: 2 }])(
  'never turns an unrecognizable list response into definitive sent absence: %j',
  async (body) => {
    install(body);
    expect(
      await server().callTool('gmail_find_sent_message', { messageId: '<job@example.test>' }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_PROVIDER_RESPONSE' } },
    });
  },
);
it.each([{ resultSizeEstimate: 0 }, { messages: [] }])(
  'preserves the documented recognizable empty-list shape: %j',
  async (body) => {
    install(body);
    expect(
      await server().callTool('gmail_find_sent_message', { messageId: '<job@example.test>' }),
    ).toMatchObject({ structuredContent: { messages: [], complete: true, nextPageToken: null } });
  },
);
it('returns large inline body metadata and an explicit provider-backed body reference without retrying a huge full request', async () => {
  const fetch = install(message(text('x'.repeat(3 * 1024 * 1024))));
  const result = await server().callTool('gmail_get_message', { id: 'm1' });
  expect(result).toMatchObject({
    structuredContent: {
      complete: false,
      nextCursor: null,
      message: {
        id: 'm1',
        complete: false,
        parts: [
          {
            size: 3 * 1024 * 1024,
            complete: false,
            bodyReference: {
              tool: 'gmail_get_attachment',
              arguments: { messageId: 'm1', partId: '' },
            },
            providerReference: {
              method: 'GET',
              path: 'users/me/messages/m1',
              query: { format: 'full' },
              supportsRange: false,
            },
          },
        ],
      },
    },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps headers and attachment refs readable for a message with a >2MiB inline attachment without downloading it', async () => {
  const fetch = install(
    message({
      partId: '',
      mimeType: 'multipart/mixed',
      headers: [{ name: 'Subject', value: 'Large fixture' }],
      parts: [
        text('ordinary', '0'),
        {
          ...text('x'.repeat(3 * 1024 * 1024), '1'),
          headers: [{ name: 'Content-Disposition', value: 'attachment' }],
        },
      ],
    }),
  );
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    structuredContent: {
      complete: false,
      message: {
        headers: [{ name: 'Subject', value: 'Large fixture' }],
        parts: [
          { complete: false },
          { partId: '1', bodyReference: { tool: 'gmail_get_attachment' } },
        ],
      },
    },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('pages large threads as small references that continue through individual message reads', async () => {
  const fetch = install({
    id: 't1',
    messages: [message(text('x'.repeat(2 * 1024 * 1024)), 'm1'), message(text('second'), 'm2')],
  });
  const first = (await server().callTool('gmail_get_thread', { id: 't1', maxResults: 1 })) as {
    structuredContent: { nextCursor: string };
  };
  expect(first).toMatchObject({
    structuredContent: {
      complete: false,
      totalMessages: 2,
      messages: [
        {
          id: 'm1',
          complete: false,
          bodyReference: { tool: 'gmail_get_message', arguments: { id: 'm1' } },
        },
      ],
    },
  });
  const second = await server().callTool('gmail_get_thread', {
    id: 't1',
    maxResults: 1,
    cursor: first.structuredContent.nextCursor,
  });
  expect(second).toMatchObject({
    structuredContent: {
      complete: false,
      nextCursor: null,
      messages: [
        { id: 'm2', bodyReference: { tool: 'gmail_get_message', arguments: { id: 'm2' } } },
      ],
    },
  });
  expect(
    fetch.mock.calls
      .filter((c) => !String(c[0]).endsWith('/profile'))
      .every((c) => new URL(c[0]).searchParams.get('format') === 'minimal'),
  ).toBe(true);
});
it('keeps non-text inline parts without filenames out of ordinary body downloads', async () => {
  const fetch = install(
    message({
      partId: '',
      mimeType: 'image/png',
      body: { size: 100, data: Buffer.alloc(100).toString('base64url') },
    }),
  );
  const result = await server().callTool('gmail_get_message', { id: 'm1' });
  expect(result).toMatchObject({ structuredContent: { complete: false } });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('never points a deferred message body back to the same ordinary read', async () => {
  install(message(text('x'.repeat(2 * 1024 * 1024))));
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    structuredContent: {
      message: {
        complete: false,
        bodyReference: { tool: 'gmail_get_attachment', arguments: { messageId: 'm1', partId: '' } },
      },
    },
  });
});
it('falls back to minimal identifiers and an official metadata reference if even MIME headers exceed the cap', async () => {
  const fetch = install(
    message({
      ...text('small'),
      headers: [{ name: 'Subject', value: 'x'.repeat(3 * 1024 * 1024) }],
    }),
  );
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    structuredContent: {
      complete: false,
      nextCursor: null,
      reason: 'METADATA_EXCEEDS_RESPONSE_LIMIT',
      message: {
        id: 'm1',
        providerReference: {
          path: 'users/me/messages/m1',
          query: { format: 'metadata' },
          supportsRange: false,
        },
      },
    },
  });
  expect(fetch.mock.calls.map((c) => new URL(c[0]).searchParams.get('format'))).toEqual([
    null,
    'full',
    'minimal',
  ]);
});
it('propagates an attachment container boundary to actionable leaf-part references', async () => {
  install(
    message({
      partId: '',
      mimeType: 'multipart/mixed',
      parts: [
        {
          partId: '1',
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Content-Disposition', value: 'attachment' }],
          parts: [text('private nested text', '1.0')],
        },
      ],
    }),
  );
  expect(await server().callTool('gmail_get_message', { id: 'm1' })).toMatchObject({
    structuredContent: {
      message: {
        parts: [
          {
            partId: '1.0',
            bodyReference: {
              tool: 'gmail_get_attachment',
              arguments: { messageId: 'm1', partId: '1.0' },
            },
          },
        ],
      },
    },
  });
  expect(
    await server().callTool('gmail_get_attachment', {
      messageId: 'm1',
      partId: '1.0',
      maxBytes: 32,
    }),
  ).toMatchObject({
    structuredContent: {
      contentBase64: Buffer.from('private nested text').toString('base64'),
      complete: true,
    },
  });
});
