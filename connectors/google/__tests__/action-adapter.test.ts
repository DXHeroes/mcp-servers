import { expect, it, vi } from 'vitest';
import { createAdapter, prepareMail } from '../src/action-adapter.js';
import type { ActionRecord, MailSettings } from '../src/action-types.js';

const route = { adapter: 'mail', agents: ['agent-a'], audiences: ['owner'] };
const payload = {
  operation: 'send',
  to: ['recipient@example.test'],
  subject: 'Subject',
  text: 'Body',
};
const record = (changes = {}): ActionRecord => ({
  id: 'action-123',
  route: 'mail',
  key: 'fixture',
  kind: 'task',
  payload: { ...payload },
  actors: ['agent-a'],
  evidence_actors: ['agent-a'],
  evidence: ['approved'],
  facts: [{ event: 'approval', audience: 'owner', kind: 'action', confidence: 'high' }],
  steps: {},
  status: 'observed',
  created_at: '2026-11-11T00:00:00Z',
  ...changes,
});
const mailbox = { emailAddress: 'sender@example.test', verified: true, source: 'users.getProfile' };
function settings(): MailSettings {
  return {
    actor: 'agent-a',
    mailbox: mailbox.emailAddress,
    sender: mailbox.emailAddress,
    replyTo: 'reply@example.test',
    gateway: { call: vi.fn(async () => ({ id: 'sent' })) },
    reader: {
      call: vi.fn(async () => ({ mailbox, messages: [], nextPageToken: null, complete: true })),
    },
    authorize: vi.fn(async () => {}),
  };
}
it('tom_socket_cannot_select_another_sender', () => {
  const adapter = createAdapter(settings());
  for (const field of [
    'actor',
    'from',
    'mailbox',
    'threadId',
    'approval',
    'replyTo',
    'raw',
    'headers',
    'messageId',
    'senderDisplayName',
  ])
    expect(() => adapter.validate({ ...payload, [field]: 'other' }, route)).toThrow();
  expect(() => adapter.validate(payload, { ...route, agents: ['agent-a', 'agent-b'] })).toThrow();
  expect(() => adapter.steps(record({ actors: ['agent-b'] }), route)).toThrow();
});
it('refuses missing reader or authorize and payload above broker limit', () => {
  for (const key of ['reader', 'authorize'])
    expect(() =>
      createAdapter({ ...settings(), [key]: undefined } as unknown as MailSettings),
    ).toThrow();
  expect(() =>
    createAdapter(settings()).validate({ ...payload, text: 'x'.repeat(128001) }, route),
  ).toThrow();
});
it('binds authorization to sender alias, display name, recipients, bodies and attachment bytes', async () => {
  const config = settings();
  const original = await prepareMail(config, record(), route);
  for (const change of [
    { sender: 'alias@example.test' },
    { senderDisplayName: 'Different' },
    { replyTo: 'other@example.test' },
  ])
    expect((await prepareMail({ ...config, ...change }, record(), route)).contentHash).not.toBe(
      original.contentHash,
    );
  for (const change of [
    { to: ['other@example.test'] },
    { text: 'Changed' },
    { html: '<b>Changed</b>' },
    { attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'YQ==' }] },
  ])
    expect(
      (await prepareMail(config, record({ payload: { ...payload, ...change } }), route))
        .contentHash,
    ).not.toBe(original.contentHash);
});
it('checks current authority immediately before every write and never treats assignment as approval', async () => {
  const config = settings();
  const approved = (await prepareMail(config, record(), route)).contentHash;
  let revoked = false;
  config.authorize = vi.fn(async (r, hash) => {
    if (revoked || hash !== approved || !r.evidence.includes('approved'))
      throw Error('No authority');
  });
  const step = createAdapter(config).steps(record(), route)[0]!;
  expect(await step.read()).toEqual({ status: 'absent' });
  revoked = true;
  await expect(step.write()).rejects.toThrow();
  expect(config.gateway.call).not.toHaveBeenCalled();
  revoked = false;
  await expect(
    createAdapter(config)
      .steps(record({ evidence: ['colleague assignment'] }), route)[0]!
      .write(),
  ).rejects.toThrow();
  await expect(
    createAdapter(config)
      .steps(record({ payload: { ...payload, text: 'changed' } }), route)[0]!
      .write(),
  ).rejects.toThrow();
  expect(config.gateway.call).not.toHaveBeenCalled();
});
it('derives reply headers from authenticated same-mailbox source and binds them in the approval hash', async () => {
  const config = settings();
  config.reader.call = vi.fn(async () => ({
    mailbox,
    message: {
      id: 'source',
      threadId: 'thread',
      headers: [
        { name: 'Message-ID', value: '<original@example.test>' },
        { name: 'References', value: '<earlier@example.test>' },
        { name: 'Subject', value: 'Original subject' },
      ],
    },
  }));
  const reply = record({
    payload: {
      operation: 'reply',
      to: payload.to,
      text: 'Reply',
      sourceMessageRef: { id: 'source' },
    },
  });
  const prepared = await prepareMail(config, reply, route);
  expect(prepared.args).toMatchObject({
    from: mailbox.emailAddress,
    replyTo: config.replyTo,
    threadId: 'thread',
    subject: 'Re: Original subject',
    inReplyTo: '<original@example.test>',
    references: ['<earlier@example.test>', '<original@example.test>'],
  });
  await createAdapter(config).steps(reply, route)[0]!.write();
  expect(config.gateway.call).toHaveBeenCalledWith('reply', prepared.args);
  config.reader.call = vi.fn(async () => ({
    mailbox: { ...mailbox, emailAddress: 'wrong@example.test' },
  }));
  await expect(prepareMail(config, reply, route)).rejects.toThrow();
});
it('snapshots route settings and refuses changed record after steps were created', async () => {
  const config = settings();
  const action = record();
  const adapter = createAdapter(config);
  config.sender = 'other@example.test';
  const step = adapter.steps(action, route)[0]!;
  await step.write();
  expect(config.gateway.call).toHaveBeenCalledWith(
    'send',
    expect.objectContaining({ from: mailbox.emailAddress }),
  );
  action.payload.text = 'tampered';
  await expect(step.write()).rejects.toThrow();
});
it('expires approvals, rejects invalid authorization results and requires fresh review for a changed host alias', async () => {
  const config = settings();
  const approved = (await prepareMail(config, record(), route)).contentHash;
  let now = 10;
  config.authorize = async (_record, hash) => {
    if (now >= 20 || hash !== approved) throw Error('Expired or changed approval');
  };
  const adapter = createAdapter(config);
  now = 20;
  await expect(adapter.steps(record(), route)[0]!.write()).rejects.toThrow();
  now = 10;
  await expect(
    createAdapter({ ...config, sender: 'alias@example.test' })
      .steps(record(), route)[0]!
      .write(),
  ).rejects.toThrow();
  const invalid = { ...config, authorize: async () => false } as unknown as MailSettings;
  await expect(createAdapter(invalid).steps(record(), route)[0]!.write()).rejects.toThrow();
  expect(config.gateway.call).not.toHaveBeenCalled();
});
it('one revoked host credential does not grant or disable another installed route', async () => {
  const revoked = settings();
  revoked.gateway.call = vi.fn(async () => {
    throw Error('Credential revoked');
  });
  const other = settings();
  other.actor = 'agent-b';
  other.mailbox = 'second@example.test';
  other.sender = other.mailbox;
  await expect(createAdapter(revoked).steps(record(), route)[0]!.write()).rejects.toThrow();
  await createAdapter(other)
    .steps(record({ actors: ['agent-b'], evidence_actors: ['agent-b'] }), {
      ...route,
      agents: ['agent-b'],
    })[0]!
    .write();
  expect(other.gateway.call).toHaveBeenCalledWith(
    'send',
    expect.objectContaining({ from: other.sender }),
  );
});
it('operator replay needs a resolved predecessor and a new explicit approval in host policy', async () => {
  const config = settings();
  let predecessorResolved = false;
  const approvedActions = new Map<string, string>();
  config.authorize = async (action, hash) => {
    if (!predecessorResolved || approvedActions.get(action.id) !== hash)
      throw Error('Replay refused');
  };
  const replay = record({ id: 'action-replay', evidence: ['new-owner-instruction'] });
  const step = createAdapter(config).steps(replay, route)[0]!;
  await expect(step.write()).rejects.toThrow();
  predecessorResolved = true;
  await expect(step.write()).rejects.toThrow();
  approvedActions.set(replay.id, (await prepareMail(config, replay, route)).contentHash);
  await step.write();
  expect(config.gateway.call).toHaveBeenCalledTimes(1);
});
