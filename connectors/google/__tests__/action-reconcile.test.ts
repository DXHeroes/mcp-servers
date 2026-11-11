import { expect, it, vi } from 'vitest';
import { createAdapter, prepareMail } from '../src/action-adapter.js';
import type { ActionRecord, MailSettings } from '../src/action-types.js';

const route = { adapter: 'mail', agents: ['agent-a'], audiences: ['owner'] };
const mailbox = { emailAddress: 'sender@example.test', verified: true, source: 'users.getProfile' };
const record: ActionRecord = {
  id: 'action-123',
  route: 'mail',
  key: 'fixture',
  kind: 'task',
  payload: {
    operation: 'send',
    to: ['recipient@example.test'],
    cc: ['cc@example.test'],
    bcc: ['bcc@example.test'],
    subject: 'Předmět',
    text: 'Body',
    html: '<p>Body</p>',
    attachments: [{ filename: 'sample.txt', contentType: 'text/plain', contentBase64: 'YQ==' }],
  },
  actors: ['agent-a'],
  evidence_actors: ['agent-a'],
  evidence: ['approved'],
  facts: [],
  steps: {},
  status: 'observed',
  created_at: '2026-11-11T00:00:00Z',
};
async function fixture() {
  const config: MailSettings = {
    actor: 'agent-a',
    mailbox: mailbox.emailAddress,
    sender: mailbox.emailAddress,
    replyTo: 'reply@example.test',
    senderDisplayName: 'Sender Name',
    gateway: { call: vi.fn(async () => ({})) },
    reader: { call: vi.fn() },
    authorize: async () => {},
  };
  const prepared = await prepareMail(config, record, route);
  const bodies = ['Body', '<p>Body</p>', 'a'].map((s) => Buffer.from(s));
  const message = {
    id: 'sent',
    threadId: 'thread',
    labelIds: ['SENT'],
    complete: false,
    headers: [
      { name: 'From', value: 'Sender Name <sender@example.test>' },
      { name: 'Reply-To', value: 'reply@example.test' },
      { name: 'To', value: 'recipient@example.test' },
      { name: 'Cc', value: 'cc@example.test' },
      { name: 'Bcc', value: 'bcc@example.test' },
      { name: 'Subject', value: `=?UTF-8?B?${Buffer.from('Předmět').toString('base64')}?=` },
      { name: 'Message-ID', value: prepared.args.messageId },
    ],
    parts: bodies.map((b, i) => ({
      partId: String(i),
      mimeType: i === 1 ? 'text/html' : 'text/plain',
      filename: i === 2 ? 'sample.txt' : '',
      size: b.length,
      ...(i === 2 ? { attachment: true, attachmentId: 'external' } : {}),
      complete: false,
      bodyReference: {
        tool: 'gmail_get_attachment',
        arguments: { messageId: 'sent', partId: String(i) },
      },
    })),
  };
  const response = { mailbox, message, complete: false, nextCursor: null };
  const calls: string[] = [];
  const reader = async (alias: string, args: Record<string, unknown>) => {
    calls.push(alias);
    if (alias === 'findSent')
      return {
        mailbox,
        messages: [{ id: 'sent', threadId: 'thread' }],
        complete: true,
        nextPageToken: null,
      };
    if (alias === 'getMessage') return response;
    const i = args.attachmentId === 'external' ? 2 : Number(args.partId);
    return {
      mailbox,
      messageId: 'sent',
      ...(i === 2 ? { attachmentId: 'external' } : { partId: String(i) }),
      size: bodies[i]!.length,
      contentBase64: bodies[i]!.toString('base64'),
      complete: true,
    };
  };
  config.reader.call = vi.fn(reader);
  return {
    config,
    message,
    response,
    calls,
    reader,
    bodies,
    prepared,
    read: () => createAdapter(config).steps(record, route)[0]!.read(),
  };
}
it('verifies all explicit bytes even when ordinary message/text is incomplete and attachments are only references', async () => {
  const f = await fixture();
  expect(await f.read()).toMatchObject({
    status: 'found',
    receipt: { contentHash: f.prepared.contentHash },
  });
  expect(f.calls.filter((v) => v === 'getAttachment')).toHaveLength(3);
  expect(f.config.gateway.call).not.toHaveBeenCalled();
});
it('exhausts sent search before claiming absence or uniqueness', async () => {
  const f = await fixture();
  f.config.reader.call = vi.fn(async (alias, args) =>
    alias === 'findSent'
      ? args.pageToken
        ? {
            mailbox,
            messages: [{ id: 'sent', threadId: 'thread' }],
            complete: true,
            nextPageToken: null,
          }
        : { mailbox, messages: [], complete: false, nextPageToken: 'next' }
      : f.reader(alias, args),
  );
  expect(await f.read()).toMatchObject({ status: 'found' });
  expect(f.config.reader.call).toHaveBeenCalledWith(
    'findSent',
    expect.objectContaining({ pageToken: 'next' }),
  );
});
for (const bad of [
  {},
  { messages: [], nextPageToken: null, complete: false },
  { messages: [], nextPageToken: 'loop', complete: false },
  {
    messages: [
      { id: 'sent', threadId: 'thread' },
      { id: 'second', threadId: 'thread' },
    ],
    nextPageToken: null,
    complete: true,
  },
  {
    messages: [],
    nextPageToken: null,
    complete: true,
    mailbox: { ...mailbox, emailAddress: 'other@example.test' },
  },
  { error: 'RATE_LIMITED' },
])
  it(`fails closed on unresolved sent search ${JSON.stringify(bad)}`, async () => {
    const f = await fixture();
    f.config.reader.call = vi.fn(async () => ({ mailbox, ...bad }));
    expect(await f.read()).toMatchObject({ status: 'unknown' });
    expect(f.config.gateway.call).not.toHaveBeenCalled();
  });
for (const field of ['From', 'Reply-To', 'To', 'Cc', 'Bcc', 'Subject', 'Message-ID'])
  it(`does not reconcile changed ${field}`, async () => {
    const f = await fixture();
    f.message.headers.find((h) => h.name === field)!.value = 'other@example.test';
    expect(await f.read()).toMatchObject({ status: 'unknown' });
  });
for (const failure of [
  'changed-bytes',
  'incomplete',
  'wrong-reference',
  'oversize',
  'duplicate-part',
  'missing-parts',
  'wrong-thread',
  'not-sent',
  'duplicate-header',
])
  it(`does not reconcile ${failure}`, async () => {
    const f = await fixture();
    if (failure === 'duplicate-part') f.message.parts[1]!.partId = '0';
    if (failure === 'missing-parts') f.message.parts = [];
    if (failure === 'oversize') f.message.parts[0]!.size = 1048577;
    if (failure === 'wrong-thread') f.message.threadId = 'other';
    if (failure === 'not-sent') f.message.labelIds = [];
    if (failure === 'duplicate-header') f.message.headers.push(f.message.headers[0]!);
    f.config.reader.call = vi.fn(async (alias, args) => {
      const result = await f.reader(alias, args);
      if (alias !== 'getAttachment') return result;
      return {
        ...result,
        ...(failure === 'changed-bytes' ? { contentBase64: 'Yg==' } : {}),
        ...(failure === 'incomplete' ? { complete: false } : {}),
        ...(failure === 'wrong-reference' ? { messageId: 'other' } : {}),
      };
    });
    expect(await f.read()).toMatchObject({ status: 'unknown' });
  });
