/** Conservative reconciliation against M01 verified-mailbox reads, never a resend policy. */
import { z } from 'zod';
import type { MailSettings, PreparedMail, StepRead } from './action-types.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const headers = z.array(z.object({ name: z.string(), value: z.string() })).max(1000);
const partSchema = z.object({
  partId: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_.-]*$/),
  mimeType: z.string(),
  filename: z.string(),
  size: z.number().int().nonnegative().max(1048576),
  attachment: z.boolean().optional(),
  attachmentId: id.optional(),
});
const messageSchema = z.object({
  id,
  threadId: id,
  headers,
  parts: z.array(partSchema).max(1000).optional(),
  labelIds: z.array(z.string()).optional(),
});
type Headers = z.infer<typeof headers>;
function checked(settings: MailSettings, value: unknown): Record<string, unknown> {
  const result = z
    .object({
      mailbox: z.object({
        emailAddress: z.email(),
        verified: z.literal(true),
        source: z.literal('users.getProfile'),
      }),
    })
    .passthrough()
    .parse(value);
  if (
    result.mailbox.emailAddress.toLowerCase() !== settings.mailbox.toLowerCase() ||
    result.error ||
    result.isError
  )
    throw Error('Mailbox read identity or result is invalid');
  return result;
}
function decodeHeader(value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ');
  if (/[\r\n]/.test(unfolded)) throw Error('Invalid folded header');
  const compact = unfolded.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return compact.replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_, charset: string, encoding: string, data: string) => {
      if (!/^(utf-8|us-ascii)$/i.test(charset)) throw Error('Unsupported header encoding');
      let bytes: Buffer;
      if (encoding.toLowerCase() === 'b') {
        bytes = Buffer.from(data, 'base64');
        if (bytes.toString('base64') !== data) throw Error('Invalid header encoding');
      } else {
        const raw = data.replace(/_/g, ' ');
        if (/=(?![0-9a-f]{2})/i.test(raw) || /[^\x20-\x7e]/.test(raw))
          throw Error('Invalid header encoding');
        bytes = Buffer.from(
          raw.replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          ),
          'latin1',
        );
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
  );
}
export function header(values: Headers, name: string, required = true): string {
  const found = values.filter((h) => h.name.toLowerCase() === name.toLowerCase());
  if (found.length > 1 || (required && found.length !== 1))
    throw Error('Missing or duplicate header');
  return found.length ? decodeHeader(found[0]!.value) : '';
}
export async function readMessage(settings: MailSettings, messageId: string) {
  const response = checked(
    settings,
    await settings.reader.call('getMessage', { id: messageId, maxBodyChars: 65536 }),
  );
  const message = messageSchema.parse(response.message);
  if (message.id !== messageId) throw Error('Message reference changed');
  return message;
}
function addresses(value: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => {
      const address = entry.trim().match(/^(?:[^<>]*<([^<>]+)>|([^<>\s]+))$/);
      return z
        .email()
        .parse(address?.[1] ?? address?.[2])
        .toLowerCase();
    })
    .sort();
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function matches(
  settings: MailSettings,
  prepared: PreparedMail,
  messageId: string,
  threadId: string,
): Promise<boolean> {
  const message = await readMessage(settings, messageId);
  const args = prepared.args;
  if (
    message.threadId !== threadId ||
    (args.threadId && message.threadId !== args.threadId) ||
    !message.labelIds?.includes('SENT')
  )
    return false;
  if (
    header(message.headers, 'message-id') !== args.messageId ||
    header(message.headers, 'subject') !== args.subject
  )
    return false;
  if (
    header(message.headers, 'from') !==
    (args.senderDisplayName ? `${args.senderDisplayName} <${args.from}>` : args.from)
  )
    return false;
  if (header(message.headers, 'reply-to', false) !== (args.replyTo ?? '')) return false;
  for (const key of ['to', 'cc', 'bcc'] as const)
    if (
      !equal(
        addresses(header(message.headers, key, false)),
        (args[key] ?? []).map((v) => v.toLowerCase()).sort(),
      )
    )
      return false;
  if (header(message.headers, 'in-reply-to', false) !== (args.inReplyTo ?? '')) return false;
  if (
    header(message.headers, 'references', false).trim().split(/\s+/).filter(Boolean).join(' ') !==
    (args.references ?? []).join(' ')
  )
    return false;
  const expected = [
    ...(args.text !== undefined
      ? [
          {
            mimeType: 'text/plain',
            filename: '',
            attachment: false,
            contentBase64: Buffer.from(args.text).toString('base64'),
          },
        ]
      : []),
    ...(args.html !== undefined
      ? [
          {
            mimeType: 'text/html',
            filename: '',
            attachment: false,
            contentBase64: Buffer.from(args.html).toString('base64'),
          },
        ]
      : []),
    ...(args.attachments ?? []).map((a) => ({
      mimeType: a.contentType,
      filename: a.filename,
      attachment: true,
      contentBase64: a.contentBase64,
    })),
  ];
  if (!message.parts || message.parts.length !== expected.length) return false;
  const seen = new Set<string>();
  let bytes = 0;
  for (const [index, part] of message.parts.entries()) {
    const want = expected[index]!;
    if (seen.has(part.partId)) throw Error('Duplicate MIME part');
    seen.add(part.partId);
    bytes += part.size;
    if (bytes > 1048576) throw Error('Reconciliation size limit');
    if (
      part.mimeType !== want.mimeType ||
      part.filename !== want.filename ||
      !!part.attachment !== want.attachment
    )
      return false;
    // Always retrieve every leaf's bytes explicitly. complete only describes ordinary text
    // and references; cursored text is never mistaken for a complete body or attachment.
    const ref = part.attachmentId ? { attachmentId: part.attachmentId } : { partId: part.partId };
    const result = checked(
      settings,
      await settings.reader.call('getAttachment', {
        messageId,
        ...ref,
        maxBytes: Math.max(1, part.size),
      }),
    );
    const body = z
      .object({
        messageId: id,
        partId: z.string().optional(),
        attachmentId: id.optional(),
        size: z.number().int().nonnegative(),
        contentBase64: z.string(),
        complete: z.literal(true),
      })
      .parse(result);
    if (
      body.messageId !== messageId ||
      (part.attachmentId ? body.attachmentId !== part.attachmentId : body.partId !== part.partId)
    )
      throw Error('Part reference changed');
    const content = Buffer.from(body.contentBase64, 'base64');
    if (
      content.toString('base64') !== body.contentBase64 ||
      body.size !== content.length ||
      body.size !== part.size
    )
      throw Error('Incomplete part bytes');
    if (body.contentBase64 !== want.contentBase64) return false;
  }
  return true;
}
export async function reconcileMail(
  settings: MailSettings,
  prepared: PreparedMail,
): Promise<StepRead> {
  const seen = new Set<string>();
  const messages: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const result = checked(
      settings,
      await settings.reader.call('findSent', {
        messageId: prepared.args.messageId,
        maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
    const page = z
      .object({
        messages: z.array(z.object({ id, threadId: id })).max(100),
        complete: z.boolean(),
        nextPageToken: z.string().min(1).max(4096).nullable(),
      })
      .parse(result);
    messages.push(...page.messages);
    if (messages.length > 1) return { status: 'unknown', reason: 'send_outcome_unknown' };
    if (page.nextPageToken === null) {
      if (!page.complete) throw Error('Incomplete sent search');
      if (!messages.length) return { status: 'absent' };
      const found = messages[0]!;
      return (await matches(settings, prepared, found.id, found.threadId))
        ? {
            status: 'found',
            receipt: {
              id: found.id,
              threadId: found.threadId,
              messageId: prepared.args.messageId,
              contentHash: prepared.contentHash,
            },
          }
        : { status: 'unknown', reason: 'send_outcome_unknown' };
    }
    if (page.complete || seen.has(page.nextPageToken))
      throw Error('Invalid sent search pagination');
    seen.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
  throw Error('Sent search page limit');
}
