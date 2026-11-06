/** Google Tasks API tools. Each list returns one page and the provider's nextPageToken. */
import {
  type ApiKeyConfig,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallContext,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { z } from 'zod';
import { GoogleApiError, GoogleClient } from './client.js';

const id = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => v !== '.' && v !== '..', 'Invalid resource id');
const title = z.string().min(1).max(1024);
const timestamp = z.iso.datetime({ offset: true });
const page = {
  pageToken: z.string().min(1).max(4096).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
};
const taskFields = {
  title: title.optional(),
  notes: z.string().max(8192).optional(),
  due: timestamp.nullable().optional(),
  status: z.enum(['needsAction', 'completed']).optional(),
  completed: timestamp.nullable().optional(),
};
type Args = Record<string, unknown>;
interface Operation {
  name: string;
  description: string;
  schema: z.ZodType;
  method: string;
  path: (a: Args) => string;
  query?: readonly string[];
  body?: readonly string[];
  fixedBody?: Args;
  read?: boolean;
  destructive?: boolean;
}
const listPath = (a: Args) => `lists/${encodeURIComponent(String(a.tasklist))}`;
const taskPath = (a: Args) => `${listPath(a)}/tasks/${encodeURIComponent(String(a.task))}`;
const tasklistPath = (a: Args) => `users/@me/lists/${encodeURIComponent(String(a.tasklist))}`;
const operations: Operation[] = [
  {
    name: 'tasks_list_tasklists',
    description: 'List one page of task lists.',
    schema: z.object(page).strict(),
    method: 'GET',
    path: () => 'users/@me/lists',
    query: Object.keys(page),
    read: true,
  },
  {
    name: 'tasks_get_tasklist',
    description: 'Read a task list.',
    schema: z.object({ tasklist: id }).strict(),
    method: 'GET',
    path: tasklistPath,
    read: true,
  },
  {
    name: 'tasks_create_tasklist',
    description: 'Create a task list.',
    schema: z.object({ title }).strict(),
    method: 'POST',
    path: () => 'users/@me/lists',
    body: ['title'],
  },
  {
    name: 'tasks_rename_tasklist',
    description: 'Rename a task list.',
    schema: z.object({ tasklist: id, title }).strict(),
    method: 'PATCH',
    path: tasklistPath,
    body: ['title'],
  },
  {
    name: 'tasks_delete_tasklist',
    description: 'Permanently delete a task list and its tasks.',
    schema: z.object({ tasklist: id }).strict(),
    method: 'DELETE',
    path: tasklistPath,
    destructive: true,
  },
  {
    name: 'tasks_list_tasks',
    description:
      'List one page of tasks. Set showHidden and showCompleted to include completed tasks from Google clients.',
    schema: z
      .object({
        tasklist: id,
        ...page,
        dueMin: timestamp.optional(),
        dueMax: timestamp.optional(),
        completedMin: timestamp.optional(),
        completedMax: timestamp.optional(),
        updatedMin: timestamp.optional(),
        showCompleted: z.boolean().optional(),
        showHidden: z.boolean().optional(),
        showDeleted: z.boolean().optional(),
        showAssigned: z.boolean().optional(),
      })
      .strict(),
    method: 'GET',
    path: (a) => `${listPath(a)}/tasks`,
    query: [
      ...Object.keys(page),
      'dueMin',
      'dueMax',
      'completedMin',
      'completedMax',
      'updatedMin',
      'showCompleted',
      'showHidden',
      'showDeleted',
      'showAssigned',
    ],
    read: true,
  },
  {
    name: 'tasks_get_task',
    description: 'Read a task.',
    schema: z.object({ tasklist: id, task: id }).strict(),
    method: 'GET',
    path: taskPath,
    read: true,
  },
  {
    name: 'tasks_create_task',
    description:
      'Create a task. Due dates are RFC3339 timestamps; Google Tasks stores only the date, not time of day.',
    schema: z
      .object({
        tasklist: id,
        ...taskFields,
        title,
        parent: id.optional(),
        previous: id.optional(),
      })
      .strict(),
    method: 'POST',
    path: (a) => `${listPath(a)}/tasks`,
    query: ['parent', 'previous'],
    body: Object.keys(taskFields),
  },
  {
    name: 'tasks_update_task',
    description:
      'Patch task fields; omit fields to preserve them. Use null to clear due/completed.',
    schema: z
      .object({ tasklist: id, task: id, ...taskFields })
      .strict()
      .refine((a) => Object.keys(taskFields).some((k) => k in a), 'Supply a field to update'),
    method: 'PATCH',
    path: taskPath,
    body: Object.keys(taskFields),
  },
  {
    name: 'tasks_complete_task',
    description: 'Mark a task complete.',
    schema: z.object({ tasklist: id, task: id }).strict(),
    method: 'PATCH',
    path: taskPath,
    fixedBody: { status: 'completed' },
  },
  {
    name: 'tasks_move_task',
    description:
      'Move or reorder a task. Omit parent for top level; omit previous for first position.',
    schema: z
      .object({
        tasklist: id,
        task: id,
        parent: id.optional(),
        previous: id.optional(),
        destinationTasklist: id.optional(),
      })
      .strict(),
    method: 'POST',
    path: (a) => `${taskPath(a)}/move`,
    query: ['parent', 'previous', 'destinationTasklist'],
  },
  {
    name: 'tasks_delete_task',
    description: 'Delete a task.',
    schema: z.object({ tasklist: id, task: id }).strict(),
    method: 'DELETE',
    path: taskPath,
    destructive: true,
  },
  {
    name: 'tasks_clear_completed',
    description: 'Clear all completed tasks from a list. Google marks these tasks hidden.',
    schema: z.object({ tasklist: id }).strict(),
    method: 'POST',
    path: (a) => `${listPath(a)}/clear`,
    destructive: true,
  },
];
const pick = (a: Args, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
export class GoogleTasksServer extends McpServer {
  private readonly client: GoogleClient | null;
  constructor(credential: ApiKeyConfig | null) {
    super();
    this.client = credential?.apiKey ? new GoogleClient(credential.apiKey) : null;
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
    return operations.map((o) => ({
      name: o.name,
      description: o.description,
      inputSchema: o.schema,
      annotations: {
        readOnlyHint: o.read ?? false,
        destructiveHint: o.destructive ?? false,
        idempotentHint: o.read ?? false,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext): Promise<unknown> {
    const op = operations.find((o) => o.name === name);
    if (!op) return this.failure('UNKNOWN_TOOL');
    const parsed = op.schema.safeParse(input);
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    const args = parsed.data as Args;
    try {
      const run = () =>
        this.client!.request(
          op.method,
          op.path(args),
          pick(args, op.query ?? []),
          op.fixedBody ?? (op.body ? pick(args, op.body) : undefined),
        );
      const result = context ? await withToolCallContext(context, run) : await run();
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GoogleApiError)
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
