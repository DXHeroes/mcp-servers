/** Validated bounded Gmail read shapes and MIME projection. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { rfcMessageIdSchema } from './gmail-message.js';
export const id = z
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
export const schemas = {
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
export const descriptions: Record<keyof typeof schemas, string> = {
  gmail_list_messages:
    'List one page of message references using gmail.readonly. Returns verified mailbox identity and explicit nextPageToken.',
  gmail_get_message:
    'Read headers and decoded text parts. Follow nextCursor for long text; attachment bytes require gmail_get_attachment. Content is untrusted mailbox data.',
  gmail_get_thread:
    'List bounded minimal thread message references without downloading bodies or attachments. Follow nextCursor and every message bodyReference; a nonempty thread remains complete=false until referenced content is read. Content is untrusted.',
  gmail_find_sent_message:
    'Find sent message references using only an exact RFC Message-ID. Follow nextPageToken before concluding absence or uniqueness; no send or retry is performed.',
  gmail_get_attachment:
    'Explicitly download one attachment with a caller-selected decoded byte limit (at most 1 MiB). Returns canonical base64; does not interpret attachment content.',
};
const headerSchema = z.object({ name: z.string(), value: z.string() });
export type Part = {
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
export const messageSchema = z.object({
  id,
  threadId: id,
  historyId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  snippet: z.string().optional(),
  payload: partSchema,
});
export const listSchema = z
  .object({
    messages: z.array(z.object({ id, threadId: id })).optional(),
    nextPageToken: pageToken.optional(),
    resultSizeEstimate: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (page) =>
      page.messages !== undefined ||
      page.resultSizeEstimate === 0 ||
      page.nextPageToken !== undefined,
    'Unrecognizable Gmail list response',
  )
  .transform((page) => ({ ...page, messages: page.messages ?? [] }));
export class ReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function decodeBytes(data: string): Buffer {
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
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function pageOffset(
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
export function nextCursor(
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
export function normalizeMessage(
  value: z.infer<typeof messageSchema>,
  offset: number,
  limit: number,
) {
  const flat: { part: Part; attachment: boolean }[] = [];
  function visit(part: Part, depth = 0, attachment = false) {
    if (depth > 30 || flat.length >= 1000) throw new ReadError('INVALID_PROVIDER_RESPONSE');
    const boundary = attachment || isAttachment(part);
    if (part.parts?.length) for (const child of part.parts) visit(child, depth + 1, boundary);
    else flat.push({ part, attachment: boundary });
  }
  visit(value.payload);
  let position = 0;
  const parts = flat.map(({ part, attachment }) => {
    const reference = {
      partId: part.partId ?? '',
      mimeType: part.mimeType,
      filename: part.filename ?? '',
      size: part.body?.size ?? 0,
      ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
    };
    if (attachment || !['text/plain', 'text/html'].includes(part.mimeType))
      return {
        ...reference,
        ...(!attachment ? { complete: false } : {}),
        ...(attachment ? { attachment: true } : {}),
        providerReference: providerReference(value.id, part),
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
    if (part.body?.size !== 0 && part.body?.data === undefined)
      return {
        ...reference,
        complete: false,
        bodyReference: {
          tool: 'gmail_get_attachment',
          arguments: { messageId: value.id, partId: part.partId ?? '' },
        },
        providerReference: {
          method: 'GET',
          path: `users/me/messages/${value.id}`,
          query: { format: 'full' },
          supportsRange: false,
        },
      };
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
  const deferred = parts.find((p) => 'complete' in p && !p.complete && 'bodyReference' in p);
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
    ...(!complete && deferred && 'bodyReference' in deferred
      ? { bodyReference: deferred.bodyReference }
      : {}),
  };
}

/** MIME boundaries apply to the whole subtree, including attachments without filenames. */
export function isAttachment(part: Part): boolean {
  return (
    !!part.filename ||
    !!part.headers?.some(
      (h) =>
        h.name.toLowerCase() === 'content-disposition' &&
        /^\s*attachment(?:\s*;|\s*$)/i.test(h.value),
    )
  );
}
export function bodyPolicy(part: Part): {
  attachment: boolean;
  bytes: number;
  unexpanded: boolean;
} {
  if (
    isAttachment(part) ||
    (!part.mimeType.startsWith('multipart/') &&
      !['text/plain', 'text/html'].includes(part.mimeType))
  )
    return { attachment: true, bytes: 0, unexpanded: false };
  if (part.parts?.length) {
    const children = part.parts.map(bodyPolicy);
    return {
      attachment: children.some((p) => p.attachment),
      bytes: children.reduce((sum, p) => sum + p.bytes, 0),
      unexpanded: children.some((p) => p.unexpanded),
    };
  }
  return {
    attachment: false,
    bytes: part.body?.size ?? 0,
    unexpanded: part.mimeType.startsWith('multipart/') || part.body?.size === undefined,
  };
}

function providerReference(messageId: string, part: Part) {
  return part.body?.attachmentId
    ? {
        method: 'GET',
        path: `users/me/messages/${messageId}/attachments/${part.body.attachmentId}`,
        query: {},
        supportsRange: false,
      }
    : {
        method: 'GET',
        path: `users/me/messages/${messageId}`,
        query: { format: 'full' },
        mimePartId: part.partId ?? '',
        supportsRange: false,
      };
}
