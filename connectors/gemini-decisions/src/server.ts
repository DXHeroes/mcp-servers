import {
  type ApiKeyConfig,
  McpServer,
  type McpTool,
  type ToolCallContext,
} from '@dxheroes/mcp-kit';
import { decisionSchema, readResult } from './schema.js';

const model = 'gemini-decision-1';
const api = 'https://generativelanguage.googleapis.com/v1beta';
const toolName = 'gemini_decisions';
const maxBytes = 2 * 1024 * 1024;
function failure(text: string) {
  return { isError: true, content: [{ type: 'text', text }] };
}
// Only a small structured diagnostic is needed to distinguish Google's two HTTP 400 cases.
async function invalidKeyResponse(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const limit = 16 * 1024;
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return false;
      }
      text += decoder.decode(value, { stream: true });
    }
    const details = JSON.parse(text + decoder.decode())?.error?.details;
    return (
      Array.isArray(details) &&
      details.some(
        (detail) =>
          detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
          detail.domain === 'googleapis.com' &&
          detail.reason === 'API_KEY_INVALID',
      )
    );
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

async function httpMessage(response: Response) {
  const status = response.status;
  if (status === 400) {
    if (await invalidKeyResponse(response))
      return 'Gemini Decisions HTTP 400. Google rejected the API key.';
  } else {
    await response.body?.cancel();
  }
  const reason: Record<number, string> = {
    400: 'Google rejected the input or blocked it under its safety filters.',
    401: 'Google rejected the API key.',
    403: 'Google denied access. Check the API key and project permissions.',
    429: 'Google quota or rate limit reached.',
    408: 'Google timed out.',
    504: 'Google timed out.',
  };
  return `Gemini Decisions HTTP ${status}. ${reason[status] ?? 'Google could not complete the request.'}`;
}
export class GeminiDecisionsMcpServer extends McpServer {
  constructor(private readonly config: ApiKeyConfig | null) {
    super();
  }
  async initialize(): Promise<void> {}
  async listTools(): Promise<McpTool[]> {
    return [
      {
        name: toolName,
        description:
          'Evaluate 1–1,000 named questions in one billable Gemini Decisions request. Returns typed answers, confidence and token usage.',
        inputSchema: decisionSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    ];
  }
  async listResources() {
    return [];
  }
  async readResource(): Promise<never> {
    throw new Error('No resources available.');
  }
  override async validate() {
    if (!this.config?.apiKey) return { valid: false, error: 'Gemini API key required.' };
    try {
      const response = await fetch(`${api}/models/${model}`, {
        headers: { 'x-goog-api-key': this.config.apiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return { valid: false, error: await httpMessage(response) };
      await response.body?.cancel();
      return { valid: true };
    } catch {
      return { valid: false, error: 'Could not verify Gemini model access.' };
    }
  }
  async callTool(name: string, args: unknown, context?: ToolCallContext) {
    if (name !== toolName) return failure('Unknown Gemini Decisions tool.');
    if (!this.config?.apiKey) return failure('Gemini API key required.');
    const validated = decisionSchema.safeParse(args);
    if (!validated.success)
      return failure(
        'Invalid decision input or questions. Check content blocks, names, criteria and batch limits against the tool schema.',
      );
    const body = JSON.stringify({ model, ...validated.data });
    if (Buffer.byteLength(body) > maxBytes)
      return failure('Request exceeds 2 MiB. Pass larger media using an HTTPS URI.');
    const timeout = AbortSignal.timeout(120000);
    const signal = context ? AbortSignal.any([timeout, context.signal]) : timeout;
    try {
      signal.throwIfAborted();
      const response = await fetch(`${api}/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.apiKey },
        body,
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        return failure(await httpMessage(response));
      }
      const result = readResult(await response.json(), validated.data.questions);
      if (!result) return failure('Google returned an invalid Decisions response.');
      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      if (context?.signal.aborted) return failure('Gemini Decisions request cancelled.');
      if (timeout.aborted || (error instanceof Error && error.name === 'TimeoutError'))
        return failure('Gemini Decisions request timed out.');
      if (error instanceof SyntaxError)
        return failure('Google returned an invalid Decisions response.');
      return failure('Could not complete the Gemini Decisions request.');
    }
  }
}
