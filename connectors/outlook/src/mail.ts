import type { ApiKeyConfig } from '@dxheroes/mcp-kit';
import { z } from 'zod';
import {
  type Args,
  id,
  itemBody,
  type Operation,
  OutlookServer,
  page,
  recipient,
  time,
} from './server.js';

const recipients = z.array(recipient).max(500);
const fields = {
  subject: z.string().max(4096).optional(),
  body: itemBody.optional(),
  toRecipients: recipients.optional(),
  ccRecipients: recipients.optional(),
  bccRecipients: recipients.optional(),
  replyTo: recipients.optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  categories: z.array(z.string().min(1).max(255)).max(25).optional(),
};
const message = z.object(fields).strict();
const sendMessage = message.refine(
  (m) => [m.toRecipients, m.ccRecipients, m.bccRecipients].some((r) => r && r.length > 0),
  'Supply a recipient',
);
const path = (a: Args) => `me/messages/${encodeURIComponent(String(a.messageId))}`;
const listQuery = (a: Args) => ({
  $top: a.top,
  $select: a.select,
  $orderby: a.orderBy,
  $filter: a.filter,
  $search: a.search === undefined ? undefined : JSON.stringify(a.search),
});
const operations: Operation[] = [
  {
    name: 'mail_search_messages',
    description:
      'Search one page of mail using KQL search OR an OData filter. These cannot be combined; Graph search returns at most 1000 results. Follow @odata.nextLink via nextLink.',
    schema: z
      .object({
        ...page,
        folderId: id.optional(),
        search: z.string().min(1).max(4096).optional(),
        filter: z.string().min(1).max(4096).optional(),
        select: z.string().max(2048).optional(),
        orderBy: z.string().max(1024).optional(),
      })
      .strict()
      .refine(
        (a) => !(a.search && (a.filter || a.orderBy)),
        'Search cannot be combined with filter/orderBy',
      ),
    method: 'GET',
    path: (a) =>
      a.folderId
        ? `me/mailFolders/${encodeURIComponent(String(a.folderId))}/messages`
        : 'me/messages',
    query: listQuery,
    read: true,
  },
  {
    name: 'mail_get_message',
    description: 'Read a message including its body and recipients.',
    schema: z.object({ messageId: id, select: z.string().max(2048).optional() }).strict(),
    method: 'GET',
    path,
    query: (a) => ({ $select: a.select }),
    read: true,
  },
  {
    name: 'mail_get_conversation',
    description:
      'Read one page of messages in a conversation. Follow @odata.nextLink for further messages.',
    schema: z.object({ conversationId: id, ...page }).strict(),
    method: 'GET',
    path: () => 'me/messages',
    query: (a) => ({
      $filter: `conversationId eq '${String(a.conversationId).replaceAll("'", "''")}'`,
      $top: a.top,
    }),
    read: true,
  },
  {
    name: 'mail_list_folders',
    description:
      'List one page of mail folders, or child folders of a parent. Hidden folders are optional.',
    schema: z
      .object({
        ...page,
        parentFolderId: id.optional(),
        includeHiddenFolders: z.boolean().optional(),
      })
      .strict(),
    method: 'GET',
    path: (a) =>
      a.parentFolderId
        ? `me/mailFolders/${encodeURIComponent(String(a.parentFolderId))}/childFolders`
        : 'me/mailFolders',
    query: (a) => ({ $top: a.top, includeHiddenFolders: a.includeHiddenFolders }),
    read: true,
  },
  {
    name: 'mail_create_draft',
    description: 'Create an unsent draft. This does not send mail.',
    schema: message,
    method: 'POST',
    path: () => 'me/messages',
    body: Object.keys(fields),
  },
  {
    name: 'mail_update_draft',
    description:
      'Update an unsent draft, preserving omitted fields. Graph rejects draft-only field updates after it has been sent.',
    schema: z
      .object({ messageId: id, ...fields })
      .strict()
      .refine((a) => Object.keys(fields).some((k) => k in a), 'Supply a field to update'),
    method: 'PATCH',
    path,
    body: Object.keys(fields),
  },
  {
    name: 'mail_send_draft',
    description:
      'Send an existing draft. A successful accepted response is not a delivery receipt.',
    schema: z.object({ messageId: id }).strict(),
    method: 'POST',
    path: (a) => `${path(a)}/send`,
  },
  {
    name: 'mail_send_message',
    description:
      'Send a message. Accepted means queued by Microsoft, not delivered to the recipient.',
    schema: z.object({ message: sendMessage, saveToSentItems: z.boolean().optional() }).strict(),
    method: 'POST',
    path: () => 'me/sendMail',
    body: ['message', 'saveToSentItems'],
  },
  ...(['reply', 'replyAll'] as const).map((action) => ({
    name: action === 'reply' ? 'mail_reply' : 'mail_reply_all',
    description:
      action === 'reply'
        ? 'Reply to the sender, respecting the original replyTo.'
        : 'Reply to the sender and all recipients, respecting replyTo.',
    schema: z
      .object({
        messageId: id,
        comment: z
          .string()
          .max(512 * 1024)
          .optional(),
        message: message.optional(),
      })
      .strict()
      .refine(
        (a) =>
          (a.comment !== undefined || a.message?.body !== undefined) &&
          !(a.comment !== undefined && a.message?.body !== undefined),
        'Supply comment or message.body, not both',
      ),
    method: 'POST',
    path: (a: Args) => `${path(a)}/${action}`,
    body: ['comment', 'message'],
  })),
  {
    name: 'mail_forward',
    description: 'Forward a message to the supplied recipients.',
    schema: z
      .object({
        messageId: id,
        toRecipients: recipients.min(1),
        comment: z
          .string()
          .max(512 * 1024)
          .optional(),
      })
      .strict(),
    method: 'POST',
    path: (a) => `${path(a)}/forward`,
    body: ['toRecipients', 'comment'],
  },
  {
    name: 'mail_move_message',
    description: 'Move a message to another folder; returns the destination message identifier.',
    schema: z.object({ messageId: id, destinationId: id }).strict(),
    method: 'POST',
    path: (a) => `${path(a)}/move`,
    body: ['destinationId'],
  },
  {
    name: 'mail_flag_message',
    description: 'Set or clear follow-up status and optional dates.',
    schema: z
      .object({
        messageId: id,
        flag: z
          .object({
            flagStatus: z.enum(['notFlagged', 'complete', 'flagged']),
            startDateTime: time.optional(),
            dueDateTime: time.optional(),
            completedDateTime: time.optional(),
          })
          .strict(),
      })
      .strict(),
    method: 'PATCH',
    path,
    body: ['flag'],
  },
  {
    name: 'mail_mark_read',
    description: 'Mark a message read or unread.',
    schema: z.object({ messageId: id, isRead: z.boolean() }).strict(),
    method: 'PATCH',
    path,
    body: ['isRead'],
  },
];
export class OutlookMailServer extends OutlookServer {
  constructor(credential: ApiKeyConfig | null) {
    super(credential, operations);
  }
}
