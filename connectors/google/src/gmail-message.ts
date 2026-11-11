/** Bounded MIME contract shared by the send endpoint and first-party hosts. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const maxMessageBytes = 1024 * 1024;
const mailbox = z
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/);
const recipients = z.array(mailbox).max(100);
const headerText = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
const base64 = z
  .string()
  .max(Math.ceil(maxMessageBytes / 3) * 4)
  .refine(
    (s) => s.length % 4 === 0 && Buffer.from(s, 'base64').toString('base64') === s,
    'Supply canonical padded base64',
  );
// RFC Message-ID, not Gmail's opaque API message id. Deliberately excludes quoted forms.
export const rfcMessageIdSchema = z
  .string()
  .max(254)
  .regex(
    /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?>$/,
  );
const fields = {
  messageId: rfcMessageIdSchema.optional(),
  replyTo: mailbox.optional(),
  senderDisplayName: headerText.optional(),
  from: mailbox.describe('The authenticated mailbox or a Google-authorized send-as alias.'),
  to: recipients.optional(),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: headerText,
  text: z.string().max(maxMessageBytes).optional(),
  html: z.string().max(maxMessageBytes).optional(),
  attachments: z
    .array(
      z
        .object({
          filename: headerText.refine(
            (s) => Buffer.byteLength(s) <= 255,
            'Filename exceeds 255 bytes',
          ),
          contentType: z
            .string()
            .max(127)
            .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
          contentBase64: base64,
        })
        .strict(),
    )
    .max(10)
    .optional(),
};
const replyFields = {
  threadId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  inReplyTo: rfcMessageIdSchema.describe(
    'The original RFC Message-ID header, including angle brackets.',
  ),
  references: z.array(rfcMessageIdSchema).min(1).max(50),
};
function validMessage(a: z.infer<typeof sendSchemaBase>): boolean {
  const count = (a.to?.length ?? 0) + (a.cc?.length ?? 0) + (a.bcc?.length ?? 0);
  const bytes =
    Buffer.byteLength(a.text ?? '') +
    Buffer.byteLength(a.html ?? '') +
    (a.attachments ?? []).reduce((n, f) => n + Buffer.from(f.contentBase64, 'base64').length, 0);
  return (
    count > 0 &&
    count <= 100 &&
    (a.text !== undefined || a.html !== undefined) &&
    bytes <= maxMessageBytes
  );
}
const sendSchemaBase = z.object(fields).strict();
export const gmailSendSchema = sendSchemaBase.refine(
  validMessage,
  'Supply recipients, body and at most 1 MiB of content',
);
export const gmailReplySchema = z
  .object({ ...fields, ...replyFields })
  .strict()
  .refine(validMessage, 'Supply recipients, body and at most 1 MiB of content')
  .refine((a) => a.references.at(-1) === a.inReplyTo, 'References must end with inReplyTo');
export type GmailMessageArgs = z.infer<typeof gmailSendSchema> &
  Partial<z.infer<typeof gmailReplySchema>>;

function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}
const foldedBase64 = (bytes: Buffer) =>
  bytes
    .toString('base64')
    .match(/.{1,76}/g)
    ?.join('\r\n') ?? '';
const textPart = (type: string, text: string) =>
  [
    `Content-Type: ${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    foldedBase64(Buffer.from(text)),
  ].join('\r\n');
function multipart(type: string, parts: string[]): string {
  const boundary = `dxh_${randomUUID()}`;
  return (
    `Content-Type: multipart/${type}; boundary="${boundary}"\r\n\r\n` +
    parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('') +
    `--${boundary}--`
  );
}
function attachmentPart(a: NonNullable<GmailMessageArgs['attachments']>[number]): string {
  // RFC 2231 continuations. Percent-encode every byte and split only between triplets.
  const name = [...Buffer.from(a.filename)]
    .map((b) => `%${b.toString(16).padStart(2, '0')}`)
    .join('');
  const segments = name.match(/.{1,48}/g)!;
  return [
    `Content-Type: ${a.contentType}`,
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment;',
    ...segments.map(
      (s, i) =>
        ` filename*${i}*=${i === 0 ? "utf-8''" : ''}${s}${i < segments.length - 1 ? ';' : ''}`,
    ),
    '',
    foldedBase64(Buffer.from(a.contentBase64, 'base64')),
  ].join('\r\n');
}
function rawMessage(a: GmailMessageArgs): string {
  const headers = [
    `From: ${a.senderDisplayName ? `${encodedWords(a.senderDisplayName)} <${a.from}>` : a.from}`,
    ...(a.replyTo ? [`Reply-To: ${a.replyTo}`] : []),
    ...(['to', 'cc', 'bcc'] as const).flatMap((k) =>
      a[k]?.length
        ? [`${k === 'to' ? 'To' : k === 'cc' ? 'Cc' : 'Bcc'}: ${a[k]!.join(',\r\n ')}`]
        : [],
    ),
    `Subject: ${encodedWords(a.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${a.messageId ?? `<${randomUUID()}@mcp-gateway.invalid>`}`,
    'MIME-Version: 1.0',
  ];
  if (a.inReplyTo) {
    headers.push(`In-Reply-To: ${a.inReplyTo}`, `References: ${a.references!.join('\r\n ')}`);
  }
  const parts = [
    ...(a.text !== undefined ? [textPart('text/plain', a.text)] : []),
    ...(a.html !== undefined ? [textPart('text/html', a.html)] : []),
  ];
  let body = parts.length === 1 ? parts[0]! : multipart('alternative', parts);
  if (a.attachments?.length)
    body = multipart('mixed', [body, ...a.attachments.map(attachmentPart)]);
  return Buffer.from(`${headers.join('\r\n')}\r\n${body}\r\n`).toString('base64url');
}

/** Validate and encode bounded structured input; arbitrary headers/raw MIME are rejected. */
export function buildGmailMessage(
  input: unknown,
  reply = false,
): { raw: string; threadId?: string } {
  const args = reply ? gmailReplySchema.parse(input) : gmailSendSchema.parse(input);
  return {
    raw: rawMessage(args),
    ...('threadId' in args && typeof args.threadId === 'string' ? { threadId: args.threadId } : {}),
  };
}
