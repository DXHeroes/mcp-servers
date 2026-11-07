/** Minimal read-only delegated OAuth connector. The gateway owns OAuth and refresh. */
import { GraphApiError, GraphClient } from '@dxheroes/mcp-graph';
import {
  type ApiKeyConfig,
  type McpPackage,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { type ConnectorEndpoint, UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { z } from 'zod';

const input = z.object({}).strict();
const tool = 'profile_get_me';

class ProfileServer extends McpServer {
  private readonly client: GraphClient | null;

  constructor(credential: ApiKeyConfig | null) {
    super();
    // The legacy field name is apiKey; on an OAuth route this is the user's access token.
    this.client = credential?.apiKey ? new GraphClient(credential.apiKey) : null;
  }

  async initialize(): Promise<void> {}

  async listTools(): Promise<McpTool[]> {
    return [
      {
        name: tool,
        description: 'Read the signed-in Microsoft account profile ID and display name.',
        inputSchema: input,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ];
  }

  async callTool(name: string, args: unknown, context?: ToolCallContext): Promise<unknown> {
    if (name !== tool) return failure('UNKNOWN_TOOL');
    if (!input.safeParse(args).success) return failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    try {
      const result = await withToolCallDeadline(
        20_000,
        () => this.client!.request('GET', 'me', { $select: 'id,displayName' }),
        context,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      // Never convert a definite token refusal into an empty result or a generic tool error.
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GraphApiError)
        return failure(
          error.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          error.status,
          error.retryAfterMs,
        );
      return failure('UPSTREAM_UNAVAILABLE');
    }
  }

  async listResources() {
    return [];
  }

  async readResource(): Promise<unknown> {
    throw new Error('Resource not found');
  }
}

function failure(code: string, status?: number, retryAfterMs?: number) {
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

export const mcpPackage: McpPackage = {
  metadata: {
    id: 'oauth-example-profile',
    name: 'OAuth profile example',
    description:
      'Example delegated Microsoft Graph profile reader; not a production catalog offer.',
    version: '0.1.0',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: false,
    oauthDefaults: {
      authorizationServerUrl: 'https://login.microsoftonline.com/common/v2.0',
      authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['User.Read', 'offline_access'],
      noMetadata: true,
    },
  },
  createServer: (credential) => new ProfileServer(credential),
};

export const endpoints: readonly ConnectorEndpoint[] = [
  { path: '/profile/mcp', package: mcpPackage, auth: 'oauth' },
];
