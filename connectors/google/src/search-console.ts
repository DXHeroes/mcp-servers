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

const webUrl = z
  .string()
  .max(4096)
  .pipe(z.url({ protocol: /^https?$/ }));
const siteUrl = z
  .union([
    webUrl,
    z
      .string()
      .max(265)
      .regex(/^sc-domain:[^\s/?#:@]+$/u),
  ])
  .describe('Exact domain or URL-prefix property identifier returned by list_properties.');
const sitesPath = 'webmasters/v3/sites';
const propertyPath = (site: string) => `${sitesPath}/${encodeURIComponent(site)}`;
const dimensions = z
  .array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance']))
  .max(6)
  .refine((values) => new Set(values).size === values.length, 'Dimensions must be unique.');
const report = z
  .strictObject({
    siteUrl,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    dimensions: dimensions.optional(),
    rowLimit: z.number().int().min(1).max(100).default(10),
  })
  .refine(({ startDate, endDate }) => {
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
    return days >= 0 && days < 31;
  }, 'Select up to 31 consecutive days.');

function failure(code: string, status?: number, retryAfterMs?: number) {
  const error = { code, status, retryAfterMs };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
  };
}

function operation<Schema extends z.ZodType>(
  name: string,
  description: string,
  schema: Schema,
  request: (client: GoogleClient, args: z.output<Schema>) => Promise<Record<string, unknown>>,
) {
  return {
    tool: {
      name,
      description,
      inputSchema: z.toJSONSchema(schema, { io: 'input' }) as McpTool['inputSchema'],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async call(client: GoogleClient, input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return failure('INVALID_ARGUMENTS');
      const result = await request(client, parsed.data);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}

const operations = [
  operation(
    'search_console_list_properties',
    'List properties and permission levels for the connected account.',
    z.strictObject({}),
    (client) => client.request('GET', sitesPath, {}),
  ),
  operation(
    'search_console_get_property',
    'Read the connected account’s permission level for one property.',
    z.strictObject({ siteUrl }),
    (client, args) => client.request('GET', propertyPath(args.siteUrl), {}),
  ),
  operation(
    'search_console_query_analytics',
    'Query one Search Analytics report for up to 31 inclusive Pacific dates and 1–100 rows (default 10).',
    report,
    (client, { siteUrl, ...body }) =>
      client.request('POST', `${propertyPath(siteUrl)}/searchAnalytics/query`, {}, body),
  ),
  operation(
    'search_console_inspect_url',
    'Read the Google index status of one URL under this property.',
    z.strictObject({ siteUrl, inspectionUrl: webUrl }),
    (client, body) => client.request('POST', 'v1/urlInspection/index:inspect', {}, body),
  ),
];

export class GoogleSearchConsoleServer extends McpServer {
  private readonly client: GoogleClient | null;
  constructor(credential: ApiKeyConfig | null) {
    super();
    this.client = credential?.apiKey ? new GoogleClient(credential.apiKey, 'searchConsole') : null;
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
    return operations.map(({ tool }) => tool);
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext) {
    const operation = operations.find(({ tool }) => tool.name === name);
    if (!operation) return failure('UNKNOWN_TOOL');
    const client = this.client;
    if (!client) throw new UpstreamCredentialInvalidError();
    try {
      return await withToolCallDeadline(20_000, () => operation.call(client, input ?? {}), context);
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GoogleApiError) {
        return failure(
          error.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          error.status,
          error.retryAfterMs,
        );
      }
      if (error instanceof GoogleResponseTooLargeError) return failure('RESPONSE_TOO_LARGE');
      return failure('UPSTREAM_UNAVAILABLE');
    }
  }
}
