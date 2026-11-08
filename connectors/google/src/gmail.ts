/** Send-only Gmail endpoint. It never reads a mailbox to construct a reply. */
import { randomUUID } from 'node:crypto';
import {
  type ApiKeyConfig,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { z } from 'zod';
import { GoogleApiError, GoogleClient } from './client.js';

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
const fields = {
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
// RFC Message-ID, not Gmail's opaque API message id. Deliberately excludes quoted forms.
const messageId = z
  .string()
  .max(254)
  .regex(/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/);
const replyFields = {
  threadId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  inReplyTo: messageId.describe('The original RFC Message-ID header, including angle brackets.'),
  references: z.array(messageId).min(1).max(50),
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
const sendSchema = sendSchemaBase.refine(
  validMessage,
  'Supply recipients, body and at most 1 MiB of content',
);
const replySchema = z
  .object({ ...fields, ...replyFields })
  .strict()
  .refine(validMessage, 'Supply recipients, body and at most 1 MiB of content')
  .refine((a) => a.references.at(-1) === a.inReplyTo, 'References must end with inReplyTo');
type MessageArgs = z.infer<typeof sendSchema> & Partial<z.infer<typeof replySchema>>;

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
function attachmentPart(a: NonNullable<MessageArgs['attachments']>[number]): string {
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
function rawMessage(a: MessageArgs): string {
  const headers = [
    `From: ${a.from}`,
    ...(['to', 'cc', 'bcc'] as const).flatMap((k) =>
      a[k]?.length
        ? [`${k === 'to' ? 'To' : k === 'cc' ? 'Cc' : 'Bcc'}: ${a[k]!.join(',\r\n ')}`]
        : [],
    ),
    `Subject: ${encodedWords(a.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@mcp-gateway.invalid>`,
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

export class GoogleGmailServer extends McpServer {
  private readonly client: GoogleClient | null;
  constructor(credential: ApiKeyConfig | null) {
    super();
    this.client = credential?.apiKey ? new GoogleClient(credential.apiKey, 'gmail') : null;
  }
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async listResources() {
    return [];
  }
  async readResource(): Promise<unknown> {
    throw new Error('Resource not found');
  }
  async listTools(): Promise<McpTool[]> {
    return [
      {
        name: 'gmail_send_message',
        schema: sendSchema,
        description: 'Send a new email. Requires gmail.send. This endpoint cannot read mail.',
      },
      {
        name: 'gmail_reply_message',
        schema: replySchema,
        description:
          'Send a reply using a caller-supplied Gmail threadId, original RFC Message-ID, References and matching subject. Requires gmail.send; does not fetch the original message.',
      },
    ].map((o) => ({
      name: o.name,
      description: o.description,
      inputSchema: o.schema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext): Promise<unknown> {
    const schema =
      name === 'gmail_send_message'
        ? sendSchema
        : name === 'gmail_reply_message'
          ? replySchema
          : null;
    if (!schema) return this.failure('UNKNOWN_TOOL');
    const parsed = schema.safeParse(input);
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    try {
      const args = parsed.data;
      const result = await withToolCallDeadline(
        20_000,
        () =>
          this.client!.request(
            'POST',
            'users/me/messages/send',
            {},
            {
              raw: rawMessage(args),
              ...('threadId' in args ? { threadId: args.threadId } : {}),
            },
          ),
        context,
      );
      if (typeof result.id !== 'string' || !result.id) return this.failure('SEND_OUTCOME_UNKNOWN');
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GoogleApiError)
        return this.failure(
          error.status === 429
            ? 'RATE_LIMITED'
            : error.status >= 500
              ? 'SEND_OUTCOME_UNKNOWN'
              : 'PROVIDER_ERROR',
          error.status,
          error.retryAfterMs,
        );
      return this.failure('SEND_OUTCOME_UNKNOWN');
    }
  }
  private failure(code: string, status?: number, retryAfterMs?: number) {
    const error = {
      code,
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error }) }],
      structuredContent: { error },
    };
  }
}
