/**
 * Toggl Track MCP Server
 *
 * Wraps the Toggl Track API (v9) and Reports API (v3).
 * Provides 37 tools covering time entries, projects and their members, tasks, clients,
 * tags, workspaces, and reports.
 *
 * The tool catalogue itself lives in `./server.tool-defs.js`.
 */

import type { ApiKeyConfig, McpResource, McpTool } from '@dxheroes/mcp-kit';
import { McpServer } from '@dxheroes/mcp-kit';
import { z } from 'zod';
import { TogglApiError, TogglClient } from './client.js';
import { buildTogglToolDefs, type ToolDef } from './server.tool-defs.js';

export class TogglMcpServer extends McpServer {
  private client: TogglClient | null = null;
  private initError: string | null = null;
  private toolDefs: ToolDef[] = [];

  constructor(private apiKeyConfig: ApiKeyConfig | null) {
    super();
  }

  async initialize(): Promise<void> {
    if (!this.apiKeyConfig?.apiKey) {
      this.initError =
        'Toggl API token is not configured. Please configure the API token in the MCP server settings.';
      console.warn('[Toggl] No API token configured');
      return;
    }

    try {
      this.client = new TogglClient(this.apiKeyConfig.apiKey);
      this.initError = null;
      this.toolDefs = this.buildToolDefs();
    } catch (error) {
      this.initError = `Failed to initialize Toggl client: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error('[Toggl] Initialization error:', error);
    }
  }

  override async validate(): Promise<{ valid: boolean; error?: string }> {
    if (!this.apiKeyConfig?.apiKey) {
      return { valid: false, error: 'API token not configured' };
    }

    try {
      const client = new TogglClient(this.apiKeyConfig.apiKey);
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
          'Toggl API token is not configured. Please configure the API token in the MCP server settings.',
      );
    }

    const toolDef = this.toolDefs.find((t) => t.name === name);
    if (!toolDef) {
      return this.errorResponse(
        'UNKNOWN_TOOL',
        `Unknown tool: ${name}. Use listTools() to see available tools.`,
      );
    }

    // Validate input
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

    // Execute
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
    throw new Error('No resources available in Toggl MCP');
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Toggl answers every DELETE — and some writes — with an empty 200 body,
   * which `TogglClient` surfaces as `undefined`. `JSON.stringify(undefined)`
   * *is* `undefined`, so the `text` key vanished from the content block and the
   * model received `{"content":[{"type":"text"}]}`: a result it cannot read and
   * cannot tell apart from a failure. Empty success is reported explicitly.
   *
   * What "empty" *means*, though, depends on the tool. For a write, Toggl
   * documents the empty 200 and it does mean the change was applied. For a
   * read it means nothing of the sort: `toggl_list_projects` answering with no
   * body is not "no projects" (that would be `[]`), and telling the model it
   * was a success invites it to conclude the workspace is empty. Reads
   * therefore get a result that says the answer is unknown.
   *
   * `null` is left alone — it is valid JSON and a meaningful answer
   * (`toggl_get_current_time_entry` returns it when no timer runs).
   */
  private successPayload(tool: string, result: unknown): unknown {
    if (result !== undefined) return result;
    const isRead = this.toolDefs.find((t) => t.name === tool)?.annotations.readOnlyHint === true;
    if (isRead) {
      return {
        success: false,
        tool,
        message:
          'Toggl answered with a success status but an empty body. For a read that is not an answer: it does NOT mean there are no results — an empty result set would be returned as an empty list. Treat the data as unknown, retry once, and do not report "none found" on the strength of this.',
      };
    }
    return {
      success: true,
      tool,
      message:
        'Toggl returned an empty response body, which is how it acknowledges this write — the change was applied.',
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
    if (error instanceof TogglApiError) {
      // `error.message` is the bare upstream text — the code goes in its own
      // field, so it must not be prefixed onto the message as well.
      return this.errorResponse(error.code, error.message, error.hint);
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return this.errorResponse('API_ERROR', msg);
  }

  private buildToolDefs(): ToolDef[] {
    if (!this.client) return [];
    return buildTogglToolDefs(this.client);
  }
}
