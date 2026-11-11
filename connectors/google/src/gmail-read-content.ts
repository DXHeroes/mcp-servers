/** Partial Google responses keep ordinary reads independent of inline attachment size. */
import { z } from 'zod';
import { GoogleClient, GoogleResponseTooLargeError } from './client.js';
import {
  bodyPolicy,
  fingerprint,
  id,
  messageSchema,
  nextCursor,
  normalizeMessage,
  pageOffset,
  ReadError,
} from './gmail-read-model.js';

// Explicit finite MIME projection. No body.data is ever selected by the metadata path.
const partFields = (depth: number): string =>
  `partId,mimeType,filename,headers,body(size,attachmentId)${depth ? `,parts(${partFields(depth - 1)})` : ''}`;
export const messageMetadataFields = `id,threadId,historyId,labelIds,internalDate,payload(${partFields(20)})`;
const messageFullFields = 'id,threadId,historyId,labelIds,internalDate,payload';
type MessageArgs = { id: string; maxBodyChars: number; cursor?: string };
type ThreadArgs = MessageArgs & { maxResults: number };
export async function readMessageContent(
  client: GoogleClient,
  args: MessageArgs,
  mailbox: string,
): Promise<Record<string, unknown>> {
  const path = `users/me/messages/${args.id}`;
  let raw: z.infer<typeof messageSchema>;
  try {
    raw = messageSchema.parse(
      metadataOnly(
        await client.request('GET', path, { format: 'full', fields: messageMetadataFields }),
      ),
    );
  } catch (error) {
    if (!(error instanceof GoogleResponseTooLargeError)) throw error;
    // Even unusually large MIME/header metadata keeps an actionable, smaller ID reference.
    const minimal = z
      .object({ id, threadId: id })
      .parse(await client.request('GET', path, { format: 'minimal', fields: 'id,threadId' }));
    if (minimal.id !== args.id) throw new ReadError('INVALID_PROVIDER_RESPONSE');
    if (args.cursor) throw new ReadError('STALE_CURSOR');
    return {
      message: {
        ...minimal,
        complete: false,
        providerReference: {
          method: 'GET',
          path,
          query: { format: 'metadata' },
          supportsRange: false,
        },
      },
      complete: false,
      nextCursor: null,
      reason: 'METADATA_EXCEEDS_RESPONSE_LIMIT',
    };
  }
  if (raw.id !== args.id) throw new ReadError('INVALID_PROVIDER_RESPONSE');
  const policy = bodyPolicy(raw.payload);
  // Gmail message contents are immutable. Never select full payload data when its MIME
  // structure includes an attachment or an unexpanded container. Mixed bodies are explicit refs.
  if (!policy.attachment && !policy.unexpanded && policy.bytes <= 1024 * 1024) {
    try {
      const full = messageSchema.parse(
        await client.request('GET', path, { format: 'full', fields: messageFullFields }),
      );
      if (full.id !== args.id || fingerprint(metadataOnly(full)) !== fingerprint(metadataOnly(raw)))
        throw new ReadError('STALE_CURSOR');
      raw = full;
    } catch (error) {
      if (!(error instanceof GoogleResponseTooLargeError)) throw error;
      // Retain metadata and references; do not repeat the oversized body request.
    }
  }
  const snapshot = fingerprint(raw);
  const initial = normalizeMessage(raw, 0, args.maxBodyChars);
  const offset = pageOffset(
    args.cursor,
    'message',
    args.id,
    mailbox,
    snapshot,
    initial.totalBodyChars,
  );
  const message = offset ? normalizeMessage(raw, offset, args.maxBodyChars) : initial;
  const next = offset + args.maxBodyChars;
  const continuation =
    next < message.totalBodyChars ? nextCursor('message', args.id, mailbox, snapshot, next) : null;
  return {
    message: {
      ...message,
      ...(continuation
        ? {
            bodyReference: {
              tool: 'gmail_get_message',
              arguments: { id: args.id, maxBodyChars: args.maxBodyChars, cursor: continuation },
            },
          }
        : {}),
    },
    complete: message.complete,
    nextCursor: continuation,
  };
}
function metadataOnly(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => (key === 'data' ? undefined : item)),
  );
}
export async function readThreadReferences(
  client: GoogleClient,
  args: ThreadArgs,
  mailbox: string,
): Promise<Record<string, unknown>> {
  const raw = z
    .object({
      id,
      historyId: z.string().optional(),
      messages: z.array(z.object({ id, threadId: id })),
    })
    .parse(
      await client.request('GET', `users/me/threads/${args.id}`, {
        format: 'minimal',
        fields: 'id,historyId,messages(id,threadId)',
      }),
    );
  if (raw.id !== args.id || raw.messages.some((m) => m.threadId !== args.id))
    throw new ReadError('INVALID_PROVIDER_RESPONSE');
  const snapshot = fingerprint(raw);
  const offset = pageOffset(args.cursor, 'thread', args.id, mailbox, snapshot, raw.messages.length);
  const messages = raw.messages.slice(offset, offset + args.maxResults).map((m) => ({
    ...m,
    complete: false,
    bodyReference: {
      tool: 'gmail_get_message',
      arguments: { id: m.id, maxBodyChars: args.maxBodyChars },
    },
  }));
  const next = offset + messages.length;
  return {
    id: raw.id,
    historyId: raw.historyId,
    messages,
    totalMessages: raw.messages.length,
    complete: raw.messages.length === 0,
    nextCursor:
      next < raw.messages.length ? nextCursor('thread', args.id, mailbox, snapshot, next) : null,
  };
}
export async function readInlinePart(
  client: GoogleClient,
  messageId: string,
  partId: string,
  size: number,
): Promise<{ size: number; data: string }> {
  // Explicit operation only. Google fields selectors cannot select an array element by index.
  const full = messageSchema.parse(
    await client.request('GET', `users/me/messages/${messageId}`, {
      format: 'full',
      fields: messageFullFields,
    }),
  );
  if (full.id !== messageId) throw new ReadError('INVALID_PROVIDER_RESPONSE');
  const queue = [full.payload];
  while (queue.length) {
    const part = queue.shift()!;
    if ((part.partId ?? '') === partId) {
      if (part.body?.data === undefined) throw new ReadError('ATTACHMENT_NOT_FOUND');
      if (part.body.size !== undefined && part.body.size !== size)
        throw new ReadError('STALE_CURSOR');
      return { size, data: part.body.data };
    }
    queue.push(...(part.parts ?? []));
  }
  throw new ReadError('ATTACHMENT_NOT_FOUND');
}
