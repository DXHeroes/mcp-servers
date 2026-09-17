/**
 * Abstract base class for all MCP servers
 *
 * All MCP server implementations (external, custom, remote) must extend this class.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpGetPromptResult,
  McpPrompt,
  McpResource,
  McpTool,
} from '../types/mcp.js';

/**
 * The upstream's continuation, carried back on a later round of a
 * multi-round-trip tool call.
 *
 * Both fields are the **upstream's** vocabulary travelling through this
 * host unread. That is the whole design: an intermediary that re-encodes
 * either one is an intermediary that can corrupt a conversation it does not
 * understand.
 */
export interface ToolCallResume {
  /**
   * The upstream's opaque `requestState`, echoed BYTE-EXACT. Never
   * re-encoded, never parsed. The spec has the client return it verbatim, and
   * an upstream is entitled to have integrity-protected it (HMAC/AEAD) — a
   * round trip through any encoder of ours could invalidate a MAC over bytes
   * we were never meant to look at.
   */
  requestState: string;
  /**
   * The downstream client's answers, relayed verbatim under the UPSTREAM's
   * own keys (we relayed its `inputRequests` unchanged, so the keyspaces
   * match by construction).
   *
   * `Record<string, unknown>` and not the SDK's `InputResponses` on purpose:
   * the connector host relays this vocabulary, it does not own or validate it. Typing
   * it as the SDK's union would make the connector host the party that decides which
   * elicitation/sampling/roots result shapes are legal between two other
   * parties — and would reject, at our seam, a shape a future revision adds.
   */
  inputResponses?: Record<string, unknown>;
}

/** Per-call multi-round-trip options for {@link McpServer.callToolMrtr}. */
export interface ToolCallMrtrOptions {
  /**
   * May the CALLER handle an `input_required` answer?
   *
   * Decided by the **inbound** era, not the outbound one: it says what the
   * downstream client can be told, and a legacy inbound leg has no
   * `input_required` vocabulary to tell it in — whatever the upstream can
   * produce. When `false`, an upstream that asks for input is a failure, not
   * a relay.
   */
  allowInputRequired: boolean;
  /** Present only on a resumed round. See {@link ToolCallResume}. */
  resume?: ToolCallResume;
}

/**
 * The two things a multi-round-trip tool call can end a round with.
 *
 * A discriminated union rather than "a result that might be an
 * `input_required`": the caller has to branch, and a caller that forgets is a
 * caller that relays an upstream's question downstream as if it were an
 * answer.
 */
export type ToolCallOutcome =
  | { kind: 'result'; result: unknown }
  | {
      kind: 'input_required';
      /** The upstream's opaque handle, to be sealed inside ours — never forwarded raw. */
      requestState: string;
      /** The upstream's embedded requests, relayed unchanged under its own keys. */
      inputRequests?: Record<string, unknown>;
    };

/**
 * Abstract base class for MCP servers
 */
export interface ToolCallContext {
  signal: AbortSignal;
  onProgress?: () => Promise<void>;
}

export abstract class McpServer {
  /**
   * Initialize the MCP server
   * Called once when the server is first loaded
   */
  abstract initialize(): Promise<void>;

  /**
   * List all available tools
   * @returns Array of tool definitions
   */
  abstract listTools(): Promise<McpTool[]>;

  /**
   * Clear any cached tools so the next `listTools()` fetches fresh data.
   *
   * Implementations that cache tools should override this method.
   */
  clearToolsCache(): void {
    // Default no-op - implementations can override.
  }

  /**
   * Call a tool by name
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns Tool result
   */
  abstract callTool(name: string, args: unknown, context?: ToolCallContext): Promise<unknown>;

  /**
   * Call a tool, with the multi-round-trip (MRTR) vocabulary of MCP
   * `2026-07-28` available on both ends.
   *
   * **Why this is a second method and not a wider {@link callTool}.** There
   * are ten implementors of `callTool` in this repository — `ExternalMcpServer`,
   * Several server implementations can use this base, while only a remote
   * protocol client can produce an `input_required`:
   * the SDK-backed remote client talking to an upstream that negotiated
   * `2026-07-28`. Widening the abstract signature would be a nine-file edit
   * that puts a protocol concept into `connectors/postgres`, where it has no
   * meaning and no way to arise. A virtual method with a **total** default
   * keeps the concept where it exists and leaves every other implementor
   * untouched.
   *
   * The default is total in the ordinary direction — any server type can be
   * asked to run a plain tool call, whether or not the caller could have
   * handled an `input_required` — and deliberately **fatal** in the other: a
   * `resume` names an upstream conversation this server type does not have,
   * and silently dropping the upstream's continuation would turn a relay bug
   * into a tool call that looks like it worked. See {@link ToolCallResume}.
   *
   * @param name - Tool name
   * @param args - Tool arguments
   * @param options - Whether the caller can handle an `input_required`, and
   *   the continuation to resume, if this is a later round
   */
  async callToolMrtr(
    name: string,
    args: unknown,
    options: ToolCallMrtrOptions,
  ): Promise<ToolCallOutcome> {
    if (options.resume !== undefined) {
      throw new Error(
        `Cannot resume tool '${name}': ${this.constructor.name} has no upstream ` +
          `conversation to resume. A multi-round-trip handle was routed to a server ` +
          `that does not speak the 2026-07-28 input_required vocabulary.`,
      );
    }
    return { kind: 'result', result: await this.callTool(name, args) };
  }

  /**
   * List all available resources
   * @returns Array of resource definitions
   */
  abstract listResources(): Promise<McpResource[]>;

  /**
   * Read a resource by URI
   * @param uri - Resource URI
   * @returns Resource content
   */
  abstract readResource(uri: string): Promise<unknown>;

  /**
   * List all available prompts.
   *
   * Deliberately **not** abstract, unlike `listResources`/`readResource`: a
   * default keeps every existing implementation (all `connectors/*` packages,
   * `RestApiMcpServer`, `ExternalMcpServer`) compiling unchanged. Servers that
   * do expose prompts override this.
   *
   * @returns Array of prompt definitions - empty when the server has none
   */
  async listPrompts(): Promise<McpPrompt[]> {
    return [];
  }

  /**
   * Render a prompt by name.
   *
   * Default throws, mirroring what an upstream server without prompt support
   * would answer, so a caller cannot mistake "unsupported" for "empty".
   *
   * @param _name - Prompt name
   * @param _args - Prompt arguments
   */
  async getPrompt(_name: string, _args?: Record<string, string>): Promise<McpGetPromptResult> {
    throw new Error('Method not found: prompts/get');
  }

  /**
   * Close the server and release any underlying connections/resources.
   *
   * Default is a no-op. Implementations that hold persistent connections
   * (SSE streams, spawned processes, ...) should override this. Must be
   * safe to call multiple times (idempotent).
   */
  async close(): Promise<void> {
    // Default no-op - implementations can override.
  }

  /**
   * Validate the server configuration (e.g., API key)
   * Optional method - override to implement actual validation
   * @returns Validation result with valid status and optional error message
   */
  async validate(): Promise<{ valid: boolean; error?: string }> {
    // Default implementation: assume valid if no validation needed
    return { valid: true };
  }

  /**
   * Handle a raw JSON-RPC request
   * Override this for custom request handling
   * @param request - JSON-RPC request
   * @returns JSON-RPC response, or void for notifications (requests without id)
   */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    // If this is a notification (no id), perform the action but don't return a response
    const isNotification = request.id === undefined;

    try {
      let result: unknown;

      switch (request.method) {
        case 'tools/list': {
          // MCP spec requires tools/list to return { tools: [...] } not just [...]
          const tools = await this.listTools();
          result = { tools };
          break;
        }
        case 'tools/call': {
          if (!request.params || typeof request.params !== 'object') {
            throw new Error('Invalid params for tools/call');
          }
          const params = request.params as { name: string; arguments?: unknown };
          result = await this.callTool(params.name, params.arguments);
          break;
        }
        case 'resources/list':
          result = await this.listResources();
          break;
        case 'prompts/list': {
          // MCP spec requires prompts/list to return { prompts: [...] }
          const prompts = await this.listPrompts();
          result = { prompts };
          break;
        }
        case 'prompts/get': {
          if (!request.params || typeof request.params !== 'object') {
            throw new Error('Invalid params for prompts/get');
          }
          const promptParams = request.params as {
            name: string;
            arguments?: Record<string, string>;
          };
          result = await this.getPrompt(promptParams.name, promptParams.arguments);
          break;
        }
        case 'resources/read': {
          if (!request.params || typeof request.params !== 'object') {
            throw new Error('Invalid params for resources/read');
          }
          const readParams = request.params as { uri: string };
          result = await this.readResource(readParams.uri);
          break;
        }
        default:
          throw new Error(`Unknown method: ${request.method}`);
      }

      // For notifications, don't return a response
      if (isNotification) {
        return;
      }

      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result,
      };
    } catch (error) {
      // For notifications, don't return error responses either
      if (isNotification) {
        return;
      }

      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
          data: error,
        },
      };
    }
  }
}
