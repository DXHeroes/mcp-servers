/** Read-only Gmail endpoint. Identity is proved with the same delegated user token. */
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
import {
  messageMetadataFields,
  readInlinePart,
  readMessageContent,
  readThreadReferences,
} from './gmail-read-content.js';
import {
  decodeBytes,
  descriptions,
  listSchema,
  messageSchema,
  type Part,
  ReadError,
  schemas,
} from './gmail-read-model.js';

export class GoogleGmailReadServer extends McpServer {
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
    return (Object.keys(schemas) as (keyof typeof schemas)[]).map((name) => ({
      name,
      description: descriptions[name],
      inputSchema: schemas[name],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext): Promise<unknown> {
    if (!Object.hasOwn(schemas, name)) return this.failure('UNKNOWN_TOOL');
    const tool = name as keyof typeof schemas;
    const parsed = schemas[tool].safeParse(input);
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    try {
      return await withToolCallDeadline(
        20000,
        async () => {
          const client = this.client!;
          const profile = z
            .object({ emailAddress: z.email() })
            .parse(await client.request('GET', 'users/me/profile', {}));
          const mailbox = {
            emailAddress: profile.emailAddress,
            verified: true,
            source: 'users.getProfile',
          };
          let result: Record<string, unknown>;
          if (tool === 'gmail_list_messages' || tool === 'gmail_find_sent_message') {
            const args =
              tool === 'gmail_list_messages'
                ? schemas.gmail_list_messages.parse(input)
                : schemas.gmail_find_sent_message.parse(input);
            const query = {
              maxResults: args.maxResults,
              pageToken: args.pageToken,
              ...('messageId' in args
                ? { q: `in:sent rfc822msgid:${args.messageId}` }
                : { q: args.q, includeSpamTrash: args.includeSpamTrash }),
            };
            const page = listSchema.parse(await client.request('GET', 'users/me/messages', query));
            result = {
              ...page,
              nextPageToken: page.nextPageToken ?? null,
              complete: !page.nextPageToken,
            };
          } else if (tool === 'gmail_get_message') {
            const args = schemas.gmail_get_message.parse(input);
            result = await readMessageContent(client, args, profile.emailAddress);
          } else if (tool === 'gmail_get_thread') {
            const args = schemas.gmail_get_thread.parse(input);
            result = await readThreadReferences(client, args, profile.emailAddress);
          } else {
            const args = schemas.gmail_get_attachment.parse(input);
            let attachment: unknown;
            if (args.attachmentId) {
              attachment = await client.request(
                'GET',
                `users/me/messages/${args.messageId}/attachments/${args.attachmentId}`,
                {},
              );
            } else {
              const message = messageSchema.parse(
                await client.request('GET', `users/me/messages/${args.messageId}`, {
                  format: 'full',
                  fields: messageMetadataFields,
                }),
              );
              if (message.id !== args.messageId) throw new ReadError('INVALID_PROVIDER_RESPONSE');
              const queue = [message.payload];
              let target: Part | undefined;
              for (let visited = 0; queue.length && visited < 1000; visited++) {
                const part = queue.shift()!;
                if ((part.partId ?? '') === args.partId) {
                  target = part;
                  break;
                }
                queue.push(...(part.parts ?? []));
              }
              if (!target?.body) throw new ReadError('ATTACHMENT_NOT_FOUND');
              if ((target.body.size ?? 0) > args.maxBytes)
                throw new ReadError('ATTACHMENT_TOO_LARGE');
              attachment = target.body.attachmentId
                ? await client.request(
                    'GET',
                    `users/me/messages/${args.messageId}/attachments/${target.body.attachmentId}`,
                    {},
                  )
                : await readInlinePart(client, args.messageId, args.partId!, target.body.size ?? 0);
            }
            const raw = z
              .object({ size: z.number().int().nonnegative(), data: z.string() })
              .parse(attachment);
            if (raw.size > args.maxBytes) throw new ReadError('ATTACHMENT_TOO_LARGE');
            const bytes = decodeBytes(raw.data);
            if (bytes.length > args.maxBytes) throw new ReadError('ATTACHMENT_TOO_LARGE');
            if (bytes.length !== raw.size) throw new ReadError('INVALID_PROVIDER_RESPONSE');
            result = {
              messageId: args.messageId,
              ...(args.attachmentId
                ? { attachmentId: args.attachmentId }
                : { partId: args.partId }),
              size: bytes.length,
              contentBase64: bytes.toString('base64'),
              complete: true,
            };
          }
          const structuredContent = { mailbox, ...result };
          return {
            content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
            structuredContent,
          };
        },
        context,
      );
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GoogleApiError)
        return this.failure(
          error.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          error.status,
          error.retryAfterMs,
        );
      if (error instanceof GoogleResponseTooLargeError) return this.failure('RESPONSE_TOO_LARGE');
      if (error instanceof ReadError) return this.failure(error.code);
      if (error instanceof z.ZodError) return this.failure('INVALID_PROVIDER_RESPONSE');
      return this.failure('READ_FAILED');
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
