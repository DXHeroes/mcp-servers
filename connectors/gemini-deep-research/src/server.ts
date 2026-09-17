/**
 * Gemini Deep Research MCP Server
 *
 * Provides deep research capabilities using Google's Deep Research Agent.
 * See: https://ai.google.dev/gemini-api/docs/deep-research
 */

import type {
  ApiKeyConfig,
  McpResource,
  McpTool,
  ToolAnnotations,
  ToolCallContext,
} from '@dxheroes/mcp-kit';
import { McpServer } from '@dxheroes/mcp-kit';
import { z } from 'zod';
import { classifyGeminiError } from './errors.js';
import { GeminiClient } from './gemini-client.js';

/**
 * Both tools ask questions and return prose. Neither writes anywhere the
 * caller can see.
 *
 * The annotation matters because the connector host derives a tool's risk tier from
 * it (`packages/kit/src/utils/tool-classification.ts`) and an unannotated
 * tool falls into the `write` group by default — which would put a pair of
 * read-only research calls behind whatever policy an operator applies to
 * writes.
 *
 * `idempotentHint` is false, and that is the honest part of this record.
 * Calling `deep_research` twice with the same topic is not a no-op: it starts
 * a second background task, produces a differently-worded report, and by the
 * tool's own description costs another ~$2-5 and another 5-20 minutes. The
 * cost is stated in the description where a reader will see it; there is no
 * annotation for "expensive", and inventing one here would not be read by
 * anything.
 *
 * `destructiveHint` is false and there is no `DESTRUCTIVE_TOOL` constant in
 * this file: nothing in this package deletes or overwrites anything.
 */
const READ_ONLY_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Input schema for the deep_research tool
 */
const DeepResearchInputSchema = z.object({
  topic: z
    .string()
    .min(1, 'Topic is required')
    .max(10000, 'Topic must be less than 10000 characters')
    .describe(
      'The research topic or question to investigate. Be specific and detailed for better results.',
    ),
  formatInstructions: z
    .string()
    .optional()
    .describe(
      'Optional formatting instructions for the output. Example: "Format as a technical report with: 1. Executive Summary, 2. Key Findings, 3. Detailed Analysis, 4. Conclusions"',
    ),
});

type DeepResearchInput = z.infer<typeof DeepResearchInputSchema>;

/**
 * Input schema for the deep_research_followup tool
 */
const FollowUpInputSchema = z.object({
  interactionId: z
    .string()
    .min(1, 'Interaction ID is required')
    .describe('The interaction ID from a previous deep_research call'),
  question: z
    .string()
    .min(1, 'Question is required')
    .max(2000, 'Question must be less than 2000 characters')
    .describe('A follow-up question about the research results'),
});

type FollowUpInput = z.infer<typeof FollowUpInputSchema>;

/**
 * Gemini Deep Research MCP Server
 *
 * Provides tools for conducting deep research using Google's Deep Research Agent.
 * The agent autonomously searches the web, reads sources, and synthesizes findings
 * into detailed, cited reports.
 */
export class GeminiDeepResearchMcpServer extends McpServer {
  private client: GeminiClient | null = null;
  private initError: string | null = null;

  constructor(private apiKeyConfig: ApiKeyConfig | null) {
    super();
  }

  /**
   * Initialize the MCP server
   */
  async initialize(): Promise<void> {
    if (!this.apiKeyConfig?.apiKey) {
      this.initError =
        'Gemini API key is not configured. Please configure the API key in the MCP server settings.';
      console.warn('[GeminiDeepResearch] No API key configured');
      return;
    }

    try {
      this.client = new GeminiClient(this.apiKeyConfig.apiKey);
      this.initError = null;
    } catch (error) {
      this.initError = `Failed to initialize Gemini client: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error('[GeminiDeepResearch] Initialization error:', error);
    }
  }

  /**
   * Validate the API key against the Google Gemini API
   * Actually calls the API to verify the key is valid
   */
  override async validate(): Promise<{ valid: boolean; error?: string }> {
    if (!this.apiKeyConfig?.apiKey) {
      return { valid: false, error: 'API key not configured' };
    }

    try {
      const client = new GeminiClient(this.apiKeyConfig.apiKey);
      const result = await client.validateApiKey();
      console.log('[GeminiDeepResearch] API key validation:', result);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[GeminiDeepResearch] Validation error:', errorMessage);
      return { valid: false, error: `Validation failed: ${errorMessage}` };
    }
  }

  /**
   * List available tools
   */
  async listTools(): Promise<McpTool[]> {
    return [
      {
        name: 'deep_research',
        description:
          "Conducts comprehensive, multi-step research using Google's Deep Research Agent. " +
          'The agent autonomously searches the web, reads multiple sources, and synthesizes findings ' +
          'into detailed, cited reports. Research tasks typically take 5-20 minutes to complete. ' +
          'Cost: ~$2-5 per research task. ' +
          'Best for: market analysis, technical research, literature reviews, competitive landscaping, ' +
          'due diligence, and any topic requiring thorough investigation.',
        inputSchema: DeepResearchInputSchema,
        annotations: READ_ONLY_TOOL,
      },
      {
        name: 'deep_research_followup',
        description:
          'Ask a follow-up question about a completed research. ' +
          'Use the interactionId returned from a previous deep_research call. ' +
          'Useful for clarification, summarization, or elaboration on specific sections.',
        inputSchema: FollowUpInputSchema,
        annotations: READ_ONLY_TOOL,
      },
    ];
  }

  /**
   * Call a tool
   */
  async callTool(name: string, args: unknown, context?: ToolCallContext): Promise<unknown> {
    // Bound once, then handed to the handlers. They used to reach for
    // `this.client!` past this same guard, which is a non-null assertion the
    // compiler cannot check and the linter rightly objects to.
    const client = this.client;
    if (!client) {
      return this.errorResponse(
        'API_KEY_REQUIRED',
        this.initError ||
          'Gemini API key is not configured. Please configure the API key in the MCP server settings.',
        {
          configurationHint: 'Go to MCP Servers > Gemini Deep Research > Configure API Key',
        },
      );
    }

    switch (name) {
      case 'deep_research':
        return this.handleDeepResearch(client, args, context);
      case 'deep_research_followup':
        return this.handleFollowUp(client, args, context);
      default:
        return this.errorResponse(
          'UNKNOWN_TOOL',
          `Unknown tool: ${name}. Available tools: deep_research, deep_research_followup`,
        );
    }
  }

  /**
   * Handle deep_research tool call
   */
  private async handleDeepResearch(
    client: GeminiClient,
    args: unknown,
    context?: ToolCallContext,
  ): Promise<unknown> {
    // Validate input
    let input: DeepResearchInput;
    try {
      input = DeepResearchInputSchema.parse(args);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return this.invalidInputResponse(error);
      }
      throw error;
    }

    try {
      const result = await client.deepResearch(input, ...(context ? [context] : []));

      if (result.status === 'failed') {
        return this.errorResponse('RESEARCH_FAILED', result.error || 'Research failed', {
          interactionId: result.interactionId,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: this.researchText(result.content, result.interactionId),
          },
        ],
        metadata: {
          interactionId: result.interactionId,
          citations: result.citations,
          status: result.status,
        },
      };
    } catch (error) {
      return this.handleApiError(error);
    }
  }

  /**
   * Handle deep_research_followup tool call
   */
  private async handleFollowUp(
    client: GeminiClient,
    args: unknown,
    context?: ToolCallContext,
  ): Promise<unknown> {
    // Validate input
    let input: FollowUpInput;
    try {
      input = FollowUpInputSchema.parse(args);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return this.invalidInputResponse(error);
      }
      throw error;
    }

    try {
      const result = await client.followUp(
        input.interactionId,
        input.question,
        ...(context ? [context] : []),
      );

      return {
        content: [
          {
            type: 'text',
            text: this.researchText(result.content, result.interactionId),
          },
        ],
        metadata: {
          interactionId: result.interactionId,
          status: result.status,
        },
      };
    } catch (error) {
      return this.handleApiError(error);
    }
  }

  /**
   * Serialise an error the way every other tool response in the repo does:
   * a machine-readable code in `error`, the bare text in `message`, the remedy
   * in `hint`. The code is never prefixed onto the message — that produced
   * responses reading `RATE_LIMITED: "RATE_LIMITED: ..."`.
   */
  private errorResponse(error: string, message: string, extra?: Record<string, unknown>): unknown {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error, message, ...extra }),
        },
      ],
      isError: true,
    };
  }

  private invalidInputResponse(error: z.ZodError): unknown {
    return this.errorResponse('INVALID_INPUT', 'Invalid input parameters', {
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  /**
   * Guarantee the content block carries usable text.
   *
   * `result.content` is typed `string`, but it is assembled from whatever the
   * SDK put in `outputs` — a shape change upstream, or an interaction that
   * completes with no text output, and the value is an empty string or worse.
   * Putting that straight into `text` hands the model a content block with
   * nothing in it, and "no text" reads to a model exactly like "no findings".
   * Say which one it actually is instead.
   */
  private researchText(content: unknown, interactionId: string): string {
    if (typeof content === 'string' && content.trim().length > 0) {
      return content;
    }
    return (
      'The Gemini API reported the interaction as completed but returned no text. ' +
      'This is NOT a finding of "nothing to report" — the report is missing, not empty. ' +
      `Retry, or ask a follow-up against interactionId ${interactionId}.`
    );
  }

  /**
   * Map a thrown Gemini failure onto a coded response.
   *
   * The classification lives in `errors.ts` and is shared with
   * `GeminiClient.validateApiKey()`. It used to live here as a chain of
   * `message.includes('401')` checks, with a second, different chain in the
   * client — so the same failure could be an invalid key on one path and a
   * generic research failure on the other. It also missed the case that
   * matters most: the Gemini API rejects a bad key with **400
   * INVALID_ARGUMENT / API_KEY_INVALID**, not a 401, so the digit-matching
   * branch never fired for the commonest credential problem and the model was
   * told "Research failed" instead of "fix your API key".
   */
  private handleApiError(error: unknown): unknown {
    const classified = classifyGeminiError(error);
    return this.errorResponse(
      classified.code,
      classified.message,
      classified.hint ? { hint: classified.hint } : undefined,
    );
  }

  /**
   * List available resources (none for this MCP)
   */
  async listResources(): Promise<McpResource[]> {
    return [];
  }

  /**
   * Read a resource (not supported)
   */
  async readResource(_uri: string): Promise<unknown> {
    throw new Error('No resources available in Gemini Deep Research MCP');
  }
}
