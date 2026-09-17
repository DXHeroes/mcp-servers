/**
 * Fakturoid MCP Server
 *
 * Wraps the Fakturoid API v3.
 * Provides tools covering invoices, subjects, expenses, inventory, and account info.
 */

import type { ApiKeyConfig, McpResource, McpTool } from '@dxheroes/mcp-kit';
import { McpServer } from '@dxheroes/mcp-kit';
import { z } from 'zod';
import { FakturoidApiError, FakturoidClient } from './client.js';
import type { ToolDef } from './tool-annotations.js';
import { buildExpenseToolDefs } from './tools-expenses.js';
import { buildInvoicingToolDefs } from './tools-invoicing.js';

export class FakturoidMcpServer extends McpServer {
  private client: FakturoidClient | null = null;
  private initError: string | null = null;
  private toolDefs: ToolDef[] = [];

  constructor(private apiKeyConfig: ApiKeyConfig | null) {
    super();
  }

  async initialize(): Promise<void> {
    if (!this.apiKeyConfig?.apiKey) {
      this.initError =
        'Fakturoid API key is not configured. Please configure the API key in the MCP server settings. Format: slug:client_id:client_secret';
      console.warn('[Fakturoid] No API key configured');
      return;
    }

    try {
      this.client = new FakturoidClient(this.apiKeyConfig.apiKey);
      this.initError = null;
      this.toolDefs = this.buildToolDefs();
    } catch (error) {
      this.initError = `Failed to initialize Fakturoid client: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error('[Fakturoid] Initialization error:', error);
    }
  }

  override async validate(): Promise<{ valid: boolean; error?: string }> {
    if (!this.apiKeyConfig?.apiKey) {
      return { valid: false, error: 'API key not configured' };
    }

    try {
      const client = new FakturoidClient(this.apiKeyConfig.apiKey);
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
          'Fakturoid API key is not configured. Format: slug:client_id:client_secret',
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
    throw new Error('No resources available in Fakturoid MCP');
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Fakturoid answers every DELETE with 204 No Content, and some writes with an
   * empty body, which `FakturoidClient` surfaces as `undefined`.
   * `JSON.stringify(undefined)` *is* `undefined`, so the `text` key vanished
   * from the content block and the model received
   * `{"content":[{"type":"text"}]}`: a result it cannot read and cannot tell
   * apart from a failure. Empty success is reported explicitly instead.
   *
   * What "empty" *means* depends on the tool. For a write it is how Fakturoid
   * acknowledges the change. For a read it is not an answer at all:
   * `fakturoid_list_invoices` coming back with no body is not "no invoices"
   * (that would be an empty list), and calling it a success invites the model
   * to report an empty account. Reads therefore get a payload that says the
   * result is unknown.
   *
   * `null` passes through untouched — it is valid JSON and a real answer.
   */
  private successPayload(tool: string, result: unknown): unknown {
    if (result !== undefined) return result;
    const isRead = this.toolDefs.find((t) => t.name === tool)?.annotations.readOnlyHint === true;
    if (isRead) {
      return {
        success: false,
        tool,
        message:
          'Fakturoid returned a success status with an empty body. For a read that is not an answer: it does NOT mean there are no matching records — an empty result set comes back as an empty list. Treat the data as unknown, retry once, and do not report "none found" on the strength of this.',
      };
    }
    return {
      success: true,
      tool,
      message:
        'Fakturoid returned an empty response body (204 No Content), which is how it acknowledges this write — the change was applied.',
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
    if (error instanceof FakturoidApiError) {
      // `error.message` is the bare upstream text — the code travels in its own
      // field and must not be prefixed onto the message as well.
      return this.errorResponse(error.code, error.message, error.hint);
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return this.errorResponse('API_ERROR', msg);
  }

  private buildToolDefs(): ToolDef[] {
    if (!this.client) return [];
    const c = this.client;
    return [...buildInvoicingToolDefs(c), ...buildExpenseToolDefs(c)];
  }
}
