import { expect, it, vi } from 'vitest';
import { createAdapter, prepareMail } from '../src/action-adapter.js';
import { readMessage } from '../src/action-reconcile.js';
import type { ActionRecord, MailSettings } from '../src/action-types.js';
import { normalizeMessage } from '../src/gmail-read-model.js';

const route = { adapter: 'mail', agents: ['agent-a'], audiences: ['owner'] };
const mailbox = { emailAddress: 'sender@example.test', verified: true, source: 'users.getProfile' };
const record: ActionRecord = {
  id: 'action-source-headers',
  route: 'mail',
  key: 'reply',
  kind: 'task',
  payload: {
    operation: 'reply',
    to: ['recipient@example.test'],
    text: 'Thank you',
    sourceMessageRef: { id: 'source' },
  },
  actors: ['agent-a'],
  evidence_actors: ['agent-a'],
  evidence: ['approved'],
  facts: [],
  steps: {},
  status: 'observed',
  created_at: '2026-11-11T00:00:00Z',
};
function fixture(size = 2097152) {
  // Actual M01 metadata normalization: the incoming PDF is referenced, never downloaded.
  const message = normalizeMessage(
    {
      id: 'source',
      threadId: 'thread',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'Message-ID', value: '<original@example.test>' },
          { name: 'References', value: '<earlier@example.test>' },
          { name: 'Subject', value: 'Original subject' },
        ],
        parts: [
          { partId: '0', mimeType: 'text/plain', body: { size: 4 } },
          {
            partId: '1',
            mimeType: 'application/pdf',
            filename: 'large.pdf',
            body: { size, attachmentId: 'large' },
          },
        ],
      },
    },
    0,
    65536,
  );
  const response = { mailbox, message, complete: message.complete, nextCursor: null };
  const settings: MailSettings = {
    actor: 'agent-a',
    mailbox: mailbox.emailAddress,
    sender: mailbox.emailAddress,
    gateway: {
      call: vi.fn(async () => {
        throw Error('Unexpected send');
      }),
    },
    reader: {
      call: vi.fn(async (alias) => {
        if (alias !== 'getMessage') throw Error('Unexpected attachment read');
        return response;
      }),
    },
    authorize: vi.fn(async () => {}),
  };
  return { settings, response };
}
it('prepares the same short reply from real M01 headers with a PDF at or above the download cap', async () => {
  const hashes = new Set<string>();
  for (const size of [1048576, 1048577, 2097152]) {
    const f = fixture(size);
    expect(f.response.complete).toBe(false);
    expect(f.response.message.parts[1]).toMatchObject({
      size,
      attachment: true,
      bodyReference: { tool: 'gmail_get_attachment' },
    });
    const prepared = await prepareMail(f.settings, record, route);
    expect(prepared.args).toMatchObject({
      subject: 'Re: Original subject',
      threadId: 'thread',
      inReplyTo: '<original@example.test>',
      references: ['<earlier@example.test>', '<original@example.test>'],
      text: 'Thank you',
    });
    expect(prepared.args.attachments).toBeUndefined();
    hashes.add(prepared.contentHash);
    expect(f.settings.reader.call).toHaveBeenCalledExactlyOnceWith('getMessage', {
      id: 'source',
      maxBodyChars: 65536,
    });
    expect(f.settings.gateway.call).not.toHaveBeenCalled();
    expect(f.settings.authorize).not.toHaveBeenCalled();
  }
  expect(hashes.size).toBe(1);
});
for (const bad of [
  'mailbox',
  'unverified',
  'message-id',
  'thread-id',
  'duplicate-subject',
  'duplicate-message-id',
  'duplicate-references',
  'invalid-rfc-id',
  'invalid-references',
  'invalid-subject',
  'missing-subject',
  'missing-headers',
]) {
  it(`still refuses invalid source headers or identity: ${bad}`, async () => {
    const f = fixture();
    if (bad === 'mailbox') f.response.mailbox = { ...mailbox, emailAddress: 'other@example.test' };
    if (bad === 'unverified') f.response.mailbox = { ...mailbox, verified: false };
    if (bad === 'message-id') f.response.message.id = 'other';
    if (bad === 'thread-id') f.response.message.threadId = 'invalid/thread';
    if (bad.startsWith('duplicate-')) {
      const name = bad.slice('duplicate-'.length);
      f.response.message.headers.push(
        f.response.message.headers.find((h) => h.name.toLowerCase() === name)!,
      );
    }
    if (bad === 'invalid-rfc-id') f.response.message.headers[0]!.value = 'not-an-rfc-id';
    if (bad === 'invalid-references') f.response.message.headers[1]!.value = 'not-an-rfc-id';
    if (bad === 'invalid-subject')
      f.response.message.headers[2]!.value = 'Subject\r\nInjected: header';
    if (bad === 'missing-subject') f.response.message.headers.pop();
    if (bad === 'missing-headers') f.response.message.headers = [];
    await expect(prepareMail(f.settings, record, route)).rejects.toThrow();
    expect(f.settings.gateway.call).not.toHaveBeenCalled();
    expect(f.settings.reader.call).toHaveBeenCalledTimes(1);
  });
}
it('keeps oversized SENT MIME unknown with intent preserved and no download or additional write', async () => {
  const f = fixture(1048577);
  f.response.message.labelIds = ['SENT'];
  await expect(readMessage(f.settings, 'source')).rejects.toMatchObject({
    issues: [
      expect.objectContaining({ code: 'too_big', path: ['parts', 1, 'size'], maximum: 1048576 }),
    ],
  });
  f.settings.reader.call = vi.fn(async (alias) => {
    if (alias === 'findSent')
      return {
        mailbox,
        messages: [{ id: 'source', threadId: 'thread' }],
        complete: true,
        nextPageToken: null,
      };
    if (alias === 'getMessage') return f.response;
    throw Error('Unexpected attachment read');
  });
  const pending = structuredClone(record);
  pending.payload = {
    operation: 'send',
    to: ['recipient@example.test'],
    subject: 'Reply',
    text: 'Thank you',
  };
  pending.steps = { 'mail-send': { status: 'intent' } };
  pending.status = 'uncertain';
  const step = createAdapter(f.settings).steps(pending, route)[0]!;
  for (let i = 0; i < 3; i++)
    expect(await step.read()).toEqual({ status: 'unknown', reason: 'send_outcome_unknown' });
  expect(pending.steps['mail-send']?.status).toBe('intent');
  expect(f.settings.reader.call).toHaveBeenCalledTimes(6);
  expect(f.settings.gateway.call).not.toHaveBeenCalled();
});
