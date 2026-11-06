import {
  type ApiKeyConfig,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { z } from 'zod';
import { GraphApiError, GraphClient, GraphInputError } from './client.js';
export type Args = Record<string, unknown>;
export const id = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => v !== '.' && v !== '..', 'Invalid resource id');
export const page = {
  nextLink: z.url().max(16384).optional(),
  top: z.number().int().min(1).max(1000).optional(),
};
export const time = z
  .object({
    dateTime: z.iso.datetime({ offset: true, local: true }).max(64),
    timeZone: z.string().min(1).max(100),
  })
  .strict();
export const recipient = z
  .object({
    emailAddress: z
      .object({ address: z.email().max(320), name: z.string().max(1024).optional() })
      .strict(),
  })
  .strict();
export const itemBody = z
  .object({ contentType: z.enum(['Text', 'HTML']), content: z.string().max(512 * 1024) })
  .strict();
export const pick = (args: Args, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
export interface Operation {
  name: string;
  description: string;
  schema: z.ZodType;
  method?: string;
  path?: (a: Args) => string;
  body?: readonly string[];
  query?: (a: Args) => Args;
  read?: boolean;
  destructive?: boolean;
  run?: (a: Args, client: GraphClient) => Promise<Record<string, unknown>>;
}
export abstract class OutlookServer extends McpServer {
  private readonly client: GraphClient | null;
  constructor(
    credential: ApiKeyConfig | null,
    private readonly operations: readonly Operation[],
  ) {
    super();
    this.client = credential?.apiKey ? new GraphClient(credential.apiKey) : null;
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
    return this.operations.map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: op.schema,
      annotations: {
        readOnlyHint: op.read ?? false,
        destructiveHint: op.destructive ?? false,
        idempotentHint: op.read ?? false,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext): Promise<unknown> {
    const op = this.operations.find((o) => o.name === name);
    if (!op) return this.failure('UNKNOWN_TOOL');
    const parsed = op.schema.safeParse(input);
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    const args = parsed.data as Args;
    try {
      const result = await withToolCallDeadline(
        20_000,
        async () => {
          return op.run
            ? op.run(args, this.client!)
            : this.client!.request(
                op.method!,
                op.path!(args),
                op.query?.(args),
                op.body ? pick(args, op.body) : undefined,
                args.nextLink as string | undefined,
              );
        },
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
