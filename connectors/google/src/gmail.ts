/** Send-only Gmail endpoint. It never reads a mailbox to construct a reply. */
import {
  type ApiKeyConfig,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { GoogleApiError, GoogleClient } from './client.js';
import { buildGmailMessage, gmailReplySchema, gmailSendSchema } from './gmail-message.js';

export class GoogleGmailServer extends McpServer {
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
    return [
      {
        name: 'gmail_send_message',
        schema: gmailSendSchema,
        description: 'Send a new email. Requires gmail.send. This endpoint cannot read mail.',
      },
      {
        name: 'gmail_reply_message',
        schema: gmailReplySchema,
        description:
          'Send a reply using a caller-supplied Gmail threadId, original RFC Message-ID, References and matching subject. Requires gmail.send; does not fetch the original message.',
      },
    ].map((o) => ({
      name: o.name,
      description: o.description,
      inputSchema: o.schema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext): Promise<unknown> {
    const schema =
      name === 'gmail_send_message'
        ? gmailSendSchema
        : name === 'gmail_reply_message'
          ? gmailReplySchema
          : null;
    if (!schema) return this.failure('UNKNOWN_TOOL');
    const parsed = schema.safeParse(input);
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    try {
      const result = await withToolCallDeadline(
        20_000,
        () =>
          this.client!.request(
            'POST',
            'users/me/messages/send',
            {},
            buildGmailMessage(parsed.data, name === 'gmail_reply_message'),
          ),
        context,
      );
      if (typeof result.id !== 'string' || !result.id) return this.failure('SEND_OUTCOME_UNKNOWN');
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GoogleApiError)
        return this.failure(
          error.status === 429
            ? 'RATE_LIMITED'
            : error.status >= 500
              ? 'SEND_OUTCOME_UNKNOWN'
              : 'PROVIDER_ERROR',
          error.status,
          error.retryAfterMs,
        );
      return this.failure('SEND_OUTCOME_UNKNOWN');
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
