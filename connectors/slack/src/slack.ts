import {
  type ApiKeyConfig,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { z } from 'zod';
import { SlackApiError, SlackClient } from './client.js';

const channel = z.string().regex(/^[CDG][A-Z0-9]{1,63}$/);
const timestamp = z.string().regex(/^\d{1,16}(?:\.\d{1,6})?$/);
const page = {
  cursor: z.string().min(1).max(8192).optional(),
  limit: z.number().int().min(1).max(200).default(100),
};
const range = {
  oldest: timestamp.optional(),
  latest: timestamp.optional(),
  inclusive: z.boolean().optional(),
};
function ordered(a: { oldest?: string; latest?: string }) {
  const micros = (v: string) => {
    const [seconds, fraction = ''] = v.split('.');
    return BigInt(seconds!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  };
  return !a.oldest || !a.latest || micros(a.oldest) <= micros(a.latest);
}
const message = {
  channel,
  text: z.string().min(1).max(4000),
  mrkdwn: z.boolean().optional(),
  unfurl_links: z.boolean().default(false),
  unfurl_media: z.boolean().default(false),
};
type Args = Record<string, unknown>;
interface Operation {
  name: string;
  description: string;
  schema: z.ZodType;
  method: string;
  read?: boolean;
  params?: (a: Args) => Args;
}
const operations: Operation[] = [
  {
    name: 'slack_list_conversations',
    description:
      'List one page of public/private channels and one-to-one DMs visible to the connected user. Does not include group DMs.',
    schema: z
      .object({
        ...page,
        types: z
          .array(z.enum(['public_channel', 'private_channel', 'im']))
          .min(1)
          .max(3)
          .refine((v) => new Set(v).size === v.length)
          .default(['public_channel', 'private_channel', 'im']),
        exclude_archived: z.boolean().optional(),
      })
      .strict(),
    method: 'conversations.list',
    read: true,
    params: (a) => ({ ...a, types: (a.types as string[]).join(',') }),
  },
  {
    name: 'slack_get_history',
    description:
      'Read one history page. Preserve next_cursor and has_more; internal app limits apply. No bulk history traversal.',
    schema: z
      .object({ channel, ...page, ...range })
      .strict()
      .refine(ordered, 'Reversed time range'),
    method: 'conversations.history',
    read: true,
  },
  {
    name: 'slack_get_thread',
    description:
      'Read one thread page including its parent. Supply the root message timestamp as a string.',
    schema: z
      .object({ channel, ts: timestamp, ...page, ...range })
      .strict()
      .refine(ordered, 'Reversed time range'),
    method: 'conversations.replies',
    read: true,
  },
  {
    name: 'slack_search_messages',
    description:
      'Search the connected user accessible messages with Slack query syntax. Uses numbered pages or an opaque search cursor, never both.',
    schema: z
      .object({
        query: z.string().trim().min(1).max(4000),
        count: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(8192).optional(),
        sort: z.enum(['score', 'timestamp']).optional(),
        sort_dir: z.enum(['asc', 'desc']).optional(),
      })
      .strict()
      .refine((a) => !(a.page && a.cursor), 'Choose page or cursor'),
    method: 'search.messages',
    read: true,
  },
  {
    name: 'slack_list_users',
    description:
      'List one workspace user page. Email fields require separate provider permission and are not requested by this connector.',
    schema: z.object(page).strict(),
    method: 'users.list',
    read: true,
  },
  {
    name: 'slack_get_user',
    description: 'Read a basic workspace user profile by Slack user ID.',
    schema: z.object({ user: z.string().regex(/^[UW][A-Z0-9]{1,63}$/) }).strict(),
    method: 'users.info',
    read: true,
  },
  {
    name: 'slack_post_message',
    description:
      'Post a message to an existing conversation as the connected user. Explicit Slack mentions can notify people. Link/media unfurls default off.',
    schema: z.object(message).strict(),
    method: 'chat.postMessage',
    params: (a) => ({ ...a, parse: 'none' }),
  },
  {
    name: 'slack_reply_in_thread',
    description:
      'Reply to an existing thread as the connected user. reply_broadcast optionally also posts to the conversation.',
    schema: z
      .object({ ...message, thread_ts: timestamp, reply_broadcast: z.boolean().optional() })
      .strict(),
    method: 'chat.postMessage',
    params: (a) => ({ ...a, parse: 'none' }),
  },
  {
    name: 'slack_add_reaction',
    description:
      'Add a reaction to an existing message. Emoji names omit outer colons and may include a skin-tone modifier.',
    schema: z
      .object({
        channel,
        timestamp,
        name: z
          .string()
          .max(128)
          .regex(/^[a-zA-Z0-9_+-]+(?:::skin-tone-[2-6])?$/),
      })
      .strict(),
    method: 'reactions.add',
  },
];
export class SlackServer extends McpServer {
  private readonly client: SlackClient | null;
  constructor(credential: ApiKeyConfig | null) {
    super();
    this.client = credential?.apiKey ? new SlackClient(credential.apiKey) : null;
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
      inputSchema: z.toJSONSchema(op.schema) as McpTool['inputSchema'],
      annotations: {
        readOnlyHint: op.read === true,
        destructiveHint: false,
        idempotentHint: op.read === true,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext) {
    const op = operations.find((op) => op.name === name);
    if (!op) return this.failure('UNKNOWN_TOOL');
    const parsed = op.schema.safeParse(input ?? {});
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    try {
      const args = parsed.data as Args;
      const result = await withToolCallDeadline(
        20_000,
        () => this.client!.request(op.method, op.read ? 'GET' : 'POST', op.params?.(args) ?? args),
        context,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof SlackApiError)
        return this.failure(
          error.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          error.status,
          error.providerCode,
          error.retryAfterMs,
        );
      return this.failure('UPSTREAM_UNAVAILABLE');
    }
  }
  private failure(code: string, status?: number, providerCode?: string, retryAfterMs?: number) {
    const error = {
      code,
      ...(status !== undefined ? { status } : {}),
      ...(providerCode ? { providerCode } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error }) }],
      structuredContent: { error },
    };
  }
}
