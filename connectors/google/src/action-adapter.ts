/** Sender-bound extension for an existing durable ActionBroker. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { header, readSourceHeaders, reconcileMail } from './action-reconcile.js';
import type {
  ActionAdapter,
  ActionRecord,
  ActionRoute,
  MailSettings,
  PreparedMail,
} from './action-types.js';
import { gmailReplySchema, gmailSendSchema, rfcMessageIdSchema } from './gmail-message.js';

const payloadSchema = z
  .object({
    operation: z.enum(['send', 'reply']),
    to: gmailSendSchema.shape.to,
    cc: gmailSendSchema.shape.cc,
    bcc: gmailSendSchema.shape.bcc,
    subject: gmailSendSchema.shape.subject.optional(),
    text: gmailSendSchema.shape.text,
    html: gmailSendSchema.shape.html,
    attachments: gmailSendSchema.shape.attachments,
    sourceMessageRef: z
      .object({
        id: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((p) =>
    p.operation === 'reply'
      ? !!p.sourceMessageRef && p.subject === undefined
      : !!p.subject && p.sourceMessageRef === undefined,
  );

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const binding = (record: ActionRecord) => ({
  id: record.id,
  route: record.route,
  key: record.key,
  kind: record.kind,
  payload: record.payload,
  actors: record.actors,
  evidence_actors: record.evidence_actors,
  evidence: record.evidence,
  facts: record.facts,
});
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function host(settings: MailSettings): MailSettings {
  if (
    !settings ||
    typeof settings.authorize !== 'function' ||
    typeof settings.reader?.call !== 'function' ||
    typeof settings.gateway?.call !== 'function'
  )
    throw Error('Trusted reader, gateway and authorize capabilities are required');
  z.string().min(1).max(100).parse(settings.actor);
  z.email().parse(settings.mailbox);
  gmailSendSchema.parse({
    from: settings.sender,
    replyTo: settings.replyTo,
    senderDisplayName: settings.senderDisplayName,
    to: ['validation@example.test'],
    subject: 'Validation',
    text: '',
  });
  return {
    actor: settings.actor,
    mailbox: settings.mailbox,
    sender: settings.sender,
    ...(settings.replyTo !== undefined ? { replyTo: settings.replyTo } : {}),
    ...(settings.senderDisplayName !== undefined
      ? { senderDisplayName: settings.senderDisplayName }
      : {}),
    gateway: { call: settings.gateway.call.bind(settings.gateway) },
    reader: { call: settings.reader.call.bind(settings.reader) },
    authorize: settings.authorize,
  };
}
function validate(settings: MailSettings, payload: Record<string, unknown>, route: ActionRoute) {
  if (route.agents.length !== 1 || route.agents[0] !== settings.actor)
    throw Error('Mail route must bind exactly one actor');
  if (JSON.stringify(payload).length > 128000) throw Error('Mail exceeds broker content limit');
  const parsed = payloadSchema.parse(payload);
  const { operation: _operation, sourceMessageRef: _source, ...content } = parsed;
  gmailSendSchema.parse({ ...content, subject: parsed.subject ?? 'Reply', from: settings.sender });
  return parsed;
}
function validateRecord(settings: MailSettings, record: ActionRecord, route: ActionRoute) {
  validate(settings, record.payload, route);
  if (
    record.actors.length !== 1 ||
    record.actors[0] !== settings.actor ||
    record.evidence_actors.some((a) => a !== settings.actor)
  )
    throw Error('Record actor does not match installed sender');
  if (!record.id || !record.route) throw Error('Missing action identity');
}
async function prepare(
  settings: MailSettings,
  record: ActionRecord,
  route: ActionRoute,
): Promise<PreparedMail> {
  validateRecord(settings, record, route);
  const { operation, sourceMessageRef, ...payload } = payloadSchema.parse(record.payload);
  const messageId = `<${digest({ actor: settings.actor, mailbox: settings.mailbox, id: record.id, route: record.route })}@${settings.sender.split('@')[1]}>`;
  let args: PreparedMail['args'] = {
    ...payload,
    subject: payload.subject ?? 'Reply',
    from: settings.sender,
    messageId,
    ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
    ...(settings.senderDisplayName ? { senderDisplayName: settings.senderDisplayName } : {}),
  };
  if (operation === 'reply') {
    const message = await readSourceHeaders(settings, sourceMessageRef!.id);
    const inReplyTo = rfcMessageIdSchema.parse(header(message.headers, 'message-id'));
    const prior = header(message.headers, 'references', false).trim();
    const references = prior ? prior.split(/\s+/).map((r) => rfcMessageIdSchema.parse(r)) : [];
    if (references.at(-1) !== inReplyTo) references.push(inReplyTo);
    const subject = header(message.headers, 'subject');
    args = gmailReplySchema.parse({
      ...args,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      threadId: message.threadId,
      inReplyTo,
      references,
    });
  } else args = gmailSendSchema.parse(args);
  return {
    operation,
    args,
    contentHash: digest({
      actor: settings.actor,
      mailbox: settings.mailbox,
      route: record.route,
      action: record.id,
      operation,
      sourceMessageRef,
      args,
    }),
  };
}
/** Host approval preview; use the identical installed settings and source reader at send time. */
export async function prepareMail(
  settings: MailSettings,
  record: ActionRecord,
  route: ActionRoute,
): Promise<PreparedMail> {
  return prepare(host(settings), structuredClone(record), structuredClone(route));
}
export function createAdapter(settings: MailSettings): ActionAdapter {
  const installed = host(settings);
  return {
    validate(payload, route) {
      validate(installed, payload, route);
    },
    steps(record, route) {
      validateRecord(installed, record, route);
      const snapshot = structuredClone(record);
      const boundRoute = structuredClone(route);
      const fingerprint = digest(binding(record));
      const current = async () => {
        if (fingerprint !== digest(binding(record))) throw Error('Action changed after validation');
        return prepare(installed, snapshot, boundRoute);
      };
      return [
        {
          key: 'mail-send',
          async read() {
            try {
              return await reconcileMail(installed, await current());
            } catch {
              return { status: 'unknown', reason: 'send_outcome_unknown' };
            }
          },
          async write() {
            const prepared = await current();
            const decision = await installed.authorize(
              structuredClone(snapshot),
              prepared.contentHash,
            );
            if (decision !== undefined) throw Error('Invalid authorization result');
            return installed.gateway.call(prepared.operation, prepared.args);
          },
        },
      ];
    },
  };
}
export type {
  ActionAdapter,
  ActionRecord,
  ActionRoute,
  MailGateway,
  MailSettings,
  PreparedMail,
  StepRead,
} from './action-types.js';
