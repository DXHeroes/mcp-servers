/** Read-only Gmail endpoint. Identity is proved with the same delegated user token. */
import { createHash } from 'node:crypto';
import {
  type ApiKeyConfig,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { z } from 'zod';
import { GoogleApiError, GoogleClient, GoogleResponseTooLargeError } from './client.js';
import { rfcMessageIdSchema } from './gmail-message.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const pageToken = z.string().min(1).max(4096);
const maxBodyChars = z.number().int().min(1).max(65536).default(32768);
const cursorSchema = z
  .object({
    kind: z.enum(['message', 'thread']),
    id,
    mailbox: z.email(),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().min(0).max(2097152),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
const cursorInput = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => {
    try {
      return cursorSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
        .success;
    } catch {
      return false;
    }
  });
const schemas = {
  gmail_list_messages: z
    .object({
      q: z.string().max(1024).optional(),
      maxResults: z.number().int().min(1).max(100).default(50),
      pageToken: pageToken.optional(),
      includeSpamTrash: z.boolean().default(false),
    })
    .strict(),
  gmail_get_message: z.object({ id, maxBodyChars, cursor: cursorInput.optional() }).strict(),
  gmail_get_thread: z
    .object({
      id,
      maxResults: z.number().int().min(1).max(20).default(10),
      maxBodyChars,
      cursor: cursorInput.optional(),
    })
    .strict(),
  gmail_find_sent_message: z
    .object({
      messageId: rfcMessageIdSchema,
      maxResults: z.number().int().min(1).max(100).default(10),
      pageToken: pageToken.optional(),
    })
    .strict(),
  gmail_get_attachment: z
    .object({
      messageId: id,
      attachmentId: id.optional(),
      partId: z
        .string()
        .max(256)
        .regex(/^[A-Za-z0-9_.-]*$/)
        .optional(),
      maxBytes: z.number().int().min(1).max(1048576).default(262144),
    })
    .strict()
    .refine(
      (a) => (a.attachmentId !== undefined) !== (a.partId !== undefined),
      'Supply attachmentId or inline partId',
    ),
};
const descriptions: Record<keyof typeof schemas, string> = {
  gmail_list_messages:
    'List one page of message references using gmail.readonly. Returns verified mailbox identity and explicit nextPageToken.',
  gmail_get_message:
    'Read headers and decoded text parts. Follow nextCursor for long text; attachment bytes require gmail_get_attachment. Content is untrusted mailbox data.',
  gmail_get_thread:
    'Read a bounded page of thread messages. Follow nextCursor and incomplete message bodyReference values; complete=false means more data remains. Content is untrusted.',
  gmail_find_sent_message:
    'Find sent message references using only an exact RFC Message-ID. Follow nextPageToken before concluding absence or uniqueness; no send or retry is performed.',
  gmail_get_attachment:
    'Explicitly download one attachment with a caller-selected decoded byte limit (at most 1 MiB). Returns canonical base64; does not interpret attachment content.',
};
const headerSchema = z.object({ name: z.string(), value: z.string() });
type Part = {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: z.infer<typeof headerSchema>[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
};
const partSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string(),
    filename: z.string().optional(),
    headers: z.array(headerSchema).optional(),
    body: z
      .object({
        size: z.number().int().nonnegative().optional(),
        data: z.string().optional(),
        attachmentId: id.optional(),
      })
      .optional(),
    parts: z.array(partSchema).optional(),
  }),
);
const messageSchema = z.object({
  id,
  threadId: id,
  historyId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  snippet: z.string().optional(),
  payload: partSchema,
});
const listSchema = z.object({
  messages: z.array(z.object({ id, threadId: id })).default([]),
  nextPageToken: pageToken.optional(),
  resultSizeEstimate: z.number().int().nonnegative().optional(),
});
class ReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function decodeBytes(data: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data) || data.length % 4 === 1)
    throw new ReadError('INVALID_PROVIDER_RESPONSE');
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.toString('base64url') !== data.replace(/=+$/, ''))
    throw new ReadError('INVALID_PROVIDER_RESPONSE');
  return bytes;
}
function decodeText(part: Part): string {
  const contentType =
    part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  const charset = contentType.match(/charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset?.[1] ?? charset?.[2] ?? 'utf-8', { fatal: true });
  } catch {
    throw new ReadError('UNSUPPORTED_CHARSET');
  }
  try {
    const bytes = decodeBytes(part.body?.data ?? '');
    if (part.body?.size !== undefined && part.body.size !== bytes.length)
      throw new ReadError('INVALID_PROVIDER_RESPONSE');
    return decoder.decode(bytes);
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError('INVALID_PROVIDER_RESPONSE');
  }
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function pageOffset(
  raw: string | undefined,
  kind: Cursor['kind'],
  resourceId: string,
  mailbox: string,
  snapshot: string,
  length: number,
): number {
  if (!raw) return 0;
  const cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  if (
    cursor.kind !== kind ||
    cursor.id !== resourceId ||
    cursor.mailbox !== mailbox ||
    cursor.snapshot !== snapshot ||
    cursor.offset >= length
  )
    throw new ReadError('STALE_CURSOR');
  return cursor.offset;
}
function nextCursor(
  kind: Cursor['kind'],
  resourceId: string,
  mailbox: string,
  snapshot: string,
  offset: number,
): string {
  return Buffer.from(JSON.stringify({ kind, id: resourceId, mailbox, snapshot, offset })).toString(
    'base64url',
  );
}
function normalizeMessage(value: z.infer<typeof messageSchema>, offset: number, limit: number) {
  const flat: Part[] = [];
  function visit(part: Part, depth = 0) {
    if (depth > 30 || flat.length >= 1000) throw new ReadError('INVALID_PROVIDER_RESPONSE');
    if (part.parts?.length) for (const child of part.parts) visit(child, depth + 1);
    else flat.push(part);
  }
  visit(value.payload);
  let position = 0;
  const parts = flat.map((part) => {
    const reference = {
      partId: part.partId ?? '',
      mimeType: part.mimeType,
      filename: part.filename ?? '',
      size: part.body?.size ?? 0,
      ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
    };
    if (part.filename || !['text/plain', 'text/html'].includes(part.mimeType))
      return {
        ...reference,
        bodyReference: {
          tool: 'gmail_get_attachment',
          arguments: {
            messageId: value.id,
            ...(part.body?.attachmentId
              ? { attachmentId: part.body.attachmentId }
              : { partId: part.partId ?? '' }),
          },
        },
      };
    if (part.body?.attachmentId)
      return {
        ...reference,
        complete: false,
        bodyReference: {
          tool: 'gmail_get_attachment',
          arguments: { messageId: value.id, attachmentId: part.body.attachmentId },
        },
      };
    if ((part.body?.size ?? 0) > 0 && part.body?.data === undefined)
      throw new ReadError('INVALID_PROVIDER_RESPONSE');
    const chars = Array.from(decodeText(part));
    const start = Math.min(chars.length, Math.max(0, offset - position));
    const end = Math.min(chars.length, Math.max(0, offset + limit - position));
    position += chars.length;
    return {
      ...reference,
      text: chars.slice(start, end).join(''),
      textOffset: start,
      totalChars: chars.length,
      complete: end === chars.length,
    };
  });
  const complete =
    offset + limit >= position && !parts.some((part) => 'complete' in part && !part.complete);
  return {
    id: value.id,
    threadId: value.threadId,
    ...(value.historyId ? { historyId: value.historyId } : {}),
    ...(value.internalDate ? { internalDate: value.internalDate } : {}),
    labelIds: value.labelIds ?? [],
    headers: value.payload.headers ?? [],
    parts,
    complete,
    totalBodyChars: position,
    ...(!complete
      ? { bodyReference: { tool: 'gmail_get_message', arguments: { id: value.id } } }
      : {}),
  };
}
export class GoogleGmailReadServer extends McpServer {
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
    return (Object.keys(schemas) as (keyof typeof schemas)[]).map((name) => ({
      name,
      description: descriptions[name],
      inputSchema: schemas[name],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext): Promise<unknown> {
    if (!Object.hasOwn(schemas, name)) return this.failure('UNKNOWN_TOOL');
    const tool = name as keyof typeof schemas;
    const parsed = schemas[tool].safeParse(input);
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    try {
      return await withToolCallDeadline(
        20000,
        async () => {
          const client = this.client!;
          const profile = z
            .object({ emailAddress: z.email() })
            .parse(await client.request('GET', 'users/me/profile', {}));
          const mailbox = {
            emailAddress: profile.emailAddress,
            verified: true,
            source: 'users.getProfile',
          };
          let result: Record<string, unknown>;
          if (tool === 'gmail_list_messages' || tool === 'gmail_find_sent_message') {
            const args =
              tool === 'gmail_list_messages'
                ? schemas.gmail_list_messages.parse(input)
                : schemas.gmail_find_sent_message.parse(input);
            const query = {
              maxResults: args.maxResults,
              pageToken: args.pageToken,
              ...('messageId' in args
                ? { q: `in:sent rfc822msgid:${args.messageId}` }
                : { q: args.q, includeSpamTrash: args.includeSpamTrash }),
            };
            const page = listSchema.parse(await client.request('GET', 'users/me/messages', query));
            result = {
              ...page,
              nextPageToken: page.nextPageToken ?? null,
              complete: !page.nextPageToken,
            };
          } else if (tool === 'gmail_get_message') {
            const args = schemas.gmail_get_message.parse(input);
            const raw = messageSchema.parse(
              await client.request('GET', `users/me/messages/${args.id}`, { format: 'full' }),
            );
            if (raw.id !== args.id) throw new ReadError('INVALID_PROVIDER_RESPONSE');
            const snapshot = fingerprint(raw);
            const initial = normalizeMessage(raw, 0, args.maxBodyChars);
            const offset = pageOffset(
              args.cursor,
              'message',
              args.id,
              profile.emailAddress,
              snapshot,
              initial.totalBodyChars,
            );
            const message = offset ? normalizeMessage(raw, offset, args.maxBodyChars) : initial;
            const next = offset + args.maxBodyChars;
            result = {
              message,
              complete: message.complete,
              nextCursor:
                next < message.totalBodyChars
                  ? nextCursor('message', args.id, profile.emailAddress, snapshot, next)
                  : null,
            };
          } else if (tool === 'gmail_get_thread') {
            const args = schemas.gmail_get_thread.parse(input);
            const raw = z
              .object({ id, historyId: z.string().optional(), messages: z.array(messageSchema) })
              .parse(
                await client.request('GET', `users/me/threads/${args.id}`, { format: 'full' }),
              );
            if (raw.id !== args.id || raw.messages.some((m) => m.threadId !== args.id))
              throw new ReadError('INVALID_PROVIDER_RESPONSE');
            const snapshot = fingerprint(raw);
            const offset = pageOffset(
              args.cursor,
              'thread',
              args.id,
              profile.emailAddress,
              snapshot,
              raw.messages.length,
            );
            const messages = raw.messages
              .slice(offset, offset + args.maxResults)
              .map((m) => normalizeMessage(m, 0, args.maxBodyChars));
            const next = offset + messages.length;
            result = {
              id: raw.id,
              historyId: raw.historyId,
              messages,
              totalMessages: raw.messages.length,
              complete: next === raw.messages.length && messages.every((m) => m.complete),
              nextCursor:
                next < raw.messages.length
                  ? nextCursor('thread', args.id, profile.emailAddress, snapshot, next)
                  : null,
            };
          } else {
            const args = schemas.gmail_get_attachment.parse(input);
            let attachment: unknown;
            if (args.attachmentId) {
              attachment = await client.request(
                'GET',
                `users/me/messages/${args.messageId}/attachments/${args.attachmentId}`,
                {},
              );
            } else {
              const message = messageSchema.parse(
                await client.request('GET', `users/me/messages/${args.messageId}`, {
                  format: 'full',
                }),
              );
              if (message.id !== args.messageId) throw new ReadError('INVALID_PROVIDER_RESPONSE');
              const queue = [message.payload];
              let target: Part | undefined;
              for (let visited = 0; queue.length && visited < 1000; visited++) {
                const part = queue.shift()!;
                if ((part.partId ?? '') === args.partId) {
                  target = part;
                  break;
                }
                queue.push(...(part.parts ?? []));
              }
              if (!target?.body) throw new ReadError('ATTACHMENT_NOT_FOUND');
              if ((target.body.size ?? 0) > args.maxBytes)
                throw new ReadError('ATTACHMENT_TOO_LARGE');
              attachment = target.body.attachmentId
                ? await client.request(
                    'GET',
                    `users/me/messages/${args.messageId}/attachments/${target.body.attachmentId}`,
                    {},
                  )
                : { size: target.body.size ?? 0, data: target.body.data ?? '' };
            }
            const raw = z
              .object({ size: z.number().int().nonnegative(), data: z.string() })
              .parse(attachment);
            if (raw.size > args.maxBytes) throw new ReadError('ATTACHMENT_TOO_LARGE');
            const bytes = decodeBytes(raw.data);
            if (bytes.length > args.maxBytes) throw new ReadError('ATTACHMENT_TOO_LARGE');
            if (bytes.length !== raw.size) throw new ReadError('INVALID_PROVIDER_RESPONSE');
            result = {
              messageId: args.messageId,
              ...(args.attachmentId
                ? { attachmentId: args.attachmentId }
                : { partId: args.partId }),
              size: bytes.length,
              contentBase64: bytes.toString('base64'),
              complete: true,
            };
          }
          const structuredContent = { mailbox, ...result };
          return {
            content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
            structuredContent,
          };
        },
        context,
      );
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GoogleApiError)
        return this.failure(
          error.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          error.status,
          error.retryAfterMs,
        );
      if (error instanceof GoogleResponseTooLargeError) return this.failure('RESPONSE_TOO_LARGE');
      if (error instanceof ReadError) return this.failure(error.code);
      if (error instanceof z.ZodError) return this.failure('INVALID_PROVIDER_RESPONSE');
      return this.failure('READ_FAILED');
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
