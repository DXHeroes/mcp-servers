/**
 * Abra Flexi MCP Server
 *
 * Wraps the Abra Flexi REST API.
 * Provides 30 tools covering invoices, contacts, products, orders, bank statements, and generic records.
 */

import type { ApiKeyConfig, McpResource, McpTool } from '@dxheroes/mcp-kit';
import { McpServer } from '@dxheroes/mcp-kit';
import { z } from 'zod';
import { FlexiApiError, FlexiClient } from './client.js';
import type { ToolDef } from './tool-annotations.js';
import { buildFlexiToolDefs } from './tool-definitions.js';

export class FlexiMcpServer extends McpServer {
  private client: FlexiClient | null = null;
  private initError: string | null = null;
  private toolDefs: ToolDef[] = [];

  constructor(private apiKeyConfig: ApiKeyConfig | null) {
    super();
  }

  async initialize(): Promise<void> {
    if (!this.apiKeyConfig?.apiKey) {
      this.initError =
        'Abra Flexi API key is not configured. Please configure the API key in the MCP server settings. Format: https://server/c/company|username:password';
      console.warn('[Flexi] No API key configured');
      return;
    }

    try {
      this.client = new FlexiClient(this.apiKeyConfig.apiKey);
      this.initError = null;
      this.toolDefs = this.buildToolDefs();
    } catch (error) {
      this.initError = `Failed to initialize Flexi client: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error('[Flexi] Initialization error:', error);
    }
  }

  override async validate(): Promise<{ valid: boolean; error?: string }> {
    if (!this.apiKeyConfig?.apiKey) {
      return { valid: false, error: 'API key not configured' };
    }

    try {
      const client = new FlexiClient(this.apiKeyConfig.apiKey);
      return await client.validateApiKey();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { valid: false, error: `Validation failed: ${msg}` };
    }
  }

  async listTools(): Promise<McpTool[]> {
    if (this.toolDefs.length === 0) {
      this.toolDefs = this.buildToolDefs();
    }
    return this.toolDefs.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.client) {
      return this.errorResponse(
        'API_KEY_REQUIRED',
        this.initError ||
          'Abra Flexi API key is not configured. Format: https://server/c/company|username:password',
      );
    }

    const toolDef = this.toolDefs.find((t) => t.name === name);
    if (!toolDef) {
      return this.errorResponse(
        'UNKNOWN_TOOL',
        `Unknown tool: ${name}. Use listTools() to see available tools.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = toolDef.inputSchema.parse(args);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'INVALID_INPUT',
                message: 'Invalid input parameters',
                details: error.issues.map((issue) => ({
                  path: issue.path.join('.'),
                  message: issue.message,
                })),
              }),
            },
          ],
          isError: true,
        };
      }
      throw error;
    }

    try {
      const result = await toolDef.handler(parsed);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(this.successPayload(name, result)),
          },
        ],
      };
    } catch (error) {
      return this.handleApiError(error);
    }
  }

  async listResources(): Promise<McpResource[]> {
    return [];
  }

  async readResource(_uri: string): Promise<unknown> {
    throw new Error('No resources available in Abra Flexi MCP');
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Reports an empty upstream body explicitly instead of dropping the content.
   *
   * Flexi answers a DELETE with an empty 200, and `FlexiClient` surfaces that —
   * and any other empty body — as `undefined`. `JSON.stringify(undefined)` *is*
   * `undefined`, so the `text` key vanished from the content block and the
   * model received `{"content":[{"type":"text"}]}`: a result it can neither
   * read nor tell apart from a failure.
   *
   * What "empty" means depends on the tool. For a write, an empty 200 is how
   * Flexi acknowledges the change. For a read it means nothing of the sort:
   * `flexi_list_contacts` coming back with no body is not "no contacts" — an
   * empty evidence answers with a `winstrom` envelope holding an empty array —
   * so calling it a success would invite the model to report an empty address
   * book. Reads therefore get a result that says the answer is unknown.
   *
   * `null` is passed through untouched: it is valid JSON and a real answer.
   */
  private successPayload(tool: string, result: unknown): unknown {
    if (result !== undefined) return result;
    const isRead = this.toolDefs.find((t) => t.name === tool)?.annotations.readOnlyHint === true;
    if (isRead) {
      return {
        success: false,
        tool,
        message:
          'ABRA Flexi answered with a success status but an empty body. For a read that is not an answer: it does NOT mean there are no records — an empty evidence is returned as an empty list inside the winstrom envelope. Treat the data as unknown, retry once, and do not report "none found" on the strength of this.',
      };
    }
    return {
      success: true,
      tool,
      message:
        'ABRA Flexi returned an empty response body, which is how it acknowledges this write — the change was applied.',
    };
  }

  private errorResponse(error: string, message: string, hint?: string) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(hint ? { error, message, hint } : { error, message }),
        },
      ],
      isError: true,
    };
  }

  private handleApiError(error: unknown) {
    if (error instanceof FlexiApiError) {
      // `error.message` is the bare upstream text — the code travels in its own
      // field, so it must not be prefixed onto the message as well.
      return this.errorResponse(error.code, error.message, error.hint);
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return this.errorResponse('API_ERROR', msg);
  }

  private buildToolDefs(): ToolDef[] {
    if (!this.client) return [];
    return buildFlexiToolDefs(this.client);
  }
}
