import { GraphApiError, GraphClient, GraphInputError } from '@dxheroes/mcp-graph';
import {
  type ApiKeyConfig,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value !== '.' && value !== '..', 'Invalid resource ID');
const page = { nextLink: z.url().max(16384).optional() };
const top = z.number().int().min(1).max(50).optional();
const mention = z
  .object({
    id: z.number().int().min(0).max(49),
    mentionText: z.string().min(1).max(1024),
    mentioned: z
      .object({
        user: z
          .object({
            id: z.uuid(),
            displayName: z.string().min(1).max(1024),
            userIdentityType: z.literal('aadUser').optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const messageFields = {
  body: z
    .object({
      contentType: z.enum(['text', 'html']),
      content: z
        .string()
        .min(1)
        .max(28 * 1024),
    })
    .strict(),
  mentions: z.array(mention).min(1).max(50).optional(),
  importance: z.enum(['normal', 'high', 'urgent']).optional(),
};
function validMessage(value: {
  body: { contentType: string; content: string };
  mentions?: { id: number }[];
}): boolean {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 28 * 1024) return false;
  const tags = [...value.body.content.matchAll(/<at\s+id=(?:"(\d+)"|'(\d+)')\s*>/g)].map((match) =>
    Number(match[1] ?? match[2]),
  );
  const mentions = value.mentions ?? [];
  if (!mentions.length) return tags.length === 0;
  if (
    value.body.contentType !== 'html' ||
    new Set(mentions.map((m) => m.id)).size !== mentions.length
  )
    return false;
  return (
    mentions.every((m) => tags.includes(m.id)) &&
    tags.every((tag) => mentions.some((m) => m.id === tag))
  );
}
type Args = Record<string, unknown>;
interface Operation {
  name: string;
  description: string;
  schema: z.ZodType;
  method: 'GET' | 'POST';
  path: (args: Args) => string;
  query?: (args: Args) => Args;
  fields?: readonly string[];
  read?: boolean;
}
const enc = (value: unknown) => encodeURIComponent(String(value));
const chat = (a: Args) => `chats/${enc(a.chatId)}/messages`;
const channel = (a: Args) => `teams/${enc(a.teamId)}/channels/${enc(a.channelId)}/messages`;
const replies = (a: Args) => `${channel(a)}/${enc(a.messageId)}/replies`;
const channelIds = { teamId: id, channelId: id };
const chatRange = z
  .object({
    chatId: id,
    ...page,
    top,
    orderBy: z.enum(['lastModifiedDateTime', 'createdDateTime']).optional(),
    after: z.iso.datetime({ offset: true }).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (a) =>
      !(a.orderBy === 'createdDateTime' && a.after) &&
      (!a.after || !a.before || Date.parse(a.after) < Date.parse(a.before)),
    'Unsupported or non-increasing message range',
  );
const operations: Operation[] = [
  {
    name: 'teams_list_chats',
    description: 'List one page of the signed-in user chats. Chat members are not expanded.',
    schema: z
      .object({ ...page, top, chatType: z.enum(['oneOnOne', 'group', 'meeting']).optional() })
      .strict(),
    method: 'GET',
    path: () => 'me/chats',
    query: (a) => ({
      $top: a.top,
      $filter: a.chatType ? `chatType eq '${a.chatType}'` : undefined,
    }),
    read: true,
  },
  {
    name: 'teams_list_chat_messages',
    description:
      'Read one page of chat messages. Date filters use the selected descending order property; createdDateTime supports only before.',
    schema: chatRange,
    method: 'GET',
    path: chat,
    query: (a) => {
      const property = a.orderBy ?? 'lastModifiedDateTime';
      const filters = [
        a.after ? `${property} gt ${a.after}` : undefined,
        a.before ? `${property} lt ${a.before}` : undefined,
      ].filter(Boolean);
      return {
        $top: a.top,
        $orderby: a.orderBy || filters.length ? `${property} desc` : undefined,
        $filter: filters.length ? filters.join(' and ') : undefined,
      };
    },
    read: true,
  },
  {
    name: 'teams_send_chat_message',
    description:
      'Send a message in an existing chat; HTML mentions require matching mention objects.',
    schema: z
      .object({ chatId: id, ...messageFields })
      .strict()
      .refine(validMessage, 'Invalid mention or oversized message'),
    method: 'POST',
    path: chat,
    fields: Object.keys(messageFields),
  },
  {
    name: 'teams_list_joined_teams',
    description:
      'List teams the current user directly belongs to. Shared-channel host teams may require a separate provider API.',
    schema: z.object(page).strict(),
    method: 'GET',
    path: () => 'me/joinedTeams',
    read: true,
  },
  {
    name: 'teams_list_channels',
    description:
      'List visible channels in a joined team. Private/shared channels remain restricted by provider membership.',
    schema: z
      .object({
        teamId: id,
        ...page,
        membershipType: z.enum(['standard', 'private', 'shared']).optional(),
      })
      .strict(),
    method: 'GET',
    path: (a) => `teams/${enc(a.teamId)}/channels`,
    query: (a) => ({
      $filter: a.membershipType ? `membershipType eq '${a.membershipType}'` : undefined,
      $select: 'id,displayName,description,membershipType,webUrl',
    }),
    read: true,
  },
  {
    name: 'teams_list_channel_messages',
    description:
      'Read one page of root channel messages. Use teams_list_replies for thread replies.',
    schema: z.object({ ...channelIds, ...page, top }).strict(),
    method: 'GET',
    path: channel,
    query: (a) => ({ $top: a.top }),
    read: true,
  },
  {
    name: 'teams_list_replies',
    description: 'Read one page of replies for a specific channel thread.',
    schema: z.object({ ...channelIds, messageId: id, ...page, top }).strict(),
    method: 'GET',
    path: replies,
    query: (a) => ({ $top: a.top }),
    read: true,
  },
  {
    name: 'teams_post_channel_message',
    description: 'Post a root channel message, optionally with a subject and mentions.',
    schema: z
      .object({ ...channelIds, ...messageFields, subject: z.string().min(1).max(2048).optional() })
      .strict()
      .refine(validMessage, 'Invalid mention or oversized message'),
    method: 'POST',
    path: channel,
    fields: [...Object.keys(messageFields), 'subject'],
  },
  {
    name: 'teams_reply_in_thread',
    description: 'Reply to a specific root channel message, optionally mentioning users.',
    schema: z
      .object({ ...channelIds, messageId: id, ...messageFields })
      .strict()
      .refine(validMessage, 'Invalid mention or oversized message'),
    method: 'POST',
    path: replies,
    fields: Object.keys(messageFields),
  },
  {
    name: 'teams_search_users',
    description:
      'Find basic tenant user profiles by display name, mail or UPN prefix for mentions. Tenant guests may not use this API.',
    schema: z.object({ ...page, query: z.string().trim().min(1).max(256), top }).strict(),
    method: 'GET',
    path: () => 'users',
    query: (a) => {
      const prefix = String(a.query).replaceAll("'", "''");
      return {
        $filter: ['displayName', 'mail', 'userPrincipalName']
          .map((field) => `startswith(${field},'${prefix}')`)
          .join(' or '),
        $select: 'id,displayName,mail,userPrincipalName',
        $top: a.top,
      };
    },
    read: true,
  },
];
export class MicrosoftTeamsServer extends McpServer {
  private readonly client: GraphClient | null;
  constructor(credential: ApiKeyConfig | null) {
    super();
    this.client = credential?.apiKey
      ? new GraphClient(credential.apiKey, { roots: ['me', 'chats', 'teams', 'users'] })
      : null;
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
    return operations.map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: op.schema,
      annotations: {
        readOnlyHint: op.read ?? false,
        destructiveHint: false,
        idempotentHint: op.read ?? false,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext): Promise<unknown> {
    const op = operations.find((item) => item.name === name);
    if (!op) return this.failure('UNKNOWN_TOOL');
    const parsed = op.schema.safeParse(input);
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    const args = parsed.data as Args;
    try {
      const result = await withToolCallDeadline(
        20_000,
        () =>
          this.client!.request(
            op.method,
            op.path(args),
            op.query?.(args),
            op.fields
              ? Object.fromEntries(
                  op.fields.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
                )
              : undefined,
            args.nextLink as string | undefined,
          ),
        context,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GraphInputError) return this.failure('INVALID_ARGUMENTS');
      if (error instanceof GraphApiError)
        return this.failure(
          error.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          error.status,
          error.retryAfterMs,
        );
      return this.failure('UPSTREAM_UNAVAILABLE');
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
