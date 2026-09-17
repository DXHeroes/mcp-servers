/**
 * One place where a thrown thing becomes a coded error.
 *
 * There used to be two: `GeminiClient.validateApiKey()` matched one list of
 * substrings and `GeminiDeepResearchMcpServer.handleApiError()` matched
 * another, and the lists had already drifted apart — the client knew about
 * `UNAUTHENTICATED`, `PERMISSION_DENIED` and `API_KEY_INVALID`, the server knew
 * only about the literal digits `401`, `403` and `429`. The same upstream
 * failure could therefore be an invalid key on one path and a generic research
 * failure on the other. Both paths now call `classifyGeminiError`.
 */

/**
 * What the caller is expected to do about it.
 *
 * `INVALID_API_KEY` and `RATE_LIMITED` are separated on purpose: one wants a
 * new key and no retry, the other wants the same key and a later retry. That
 * distinction is the whole reason the code is a field of its own.
 */
export type GeminiErrorCode =
  | 'INVALID_API_KEY'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'TIMEOUT'
  | 'SERVICE_UNAVAILABLE'
  | 'API_ERROR';

/**
 * A classified Gemini failure.
 *
 * `message` is the bare upstream text. The code is NOT prefixed onto it — the
 * server serialises it as its own JSON field, and prefixing produced errors
 * that read `RATE_LIMITED: "RATE_LIMITED: ..."`.
 */
export class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly code: GeminiErrorCode,
    /** HTTP status, when the SDK reported one. */
    readonly status?: number,
    /** Actionable remedy, when one is known. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

const HINTS: Record<GeminiErrorCode, string | undefined> = {
  INVALID_API_KEY:
    'The key itself is the problem, so retrying will not help. Configure a valid Gemini API key in the MCP server settings (MCP Servers > Gemini Deep Research > Configure API Key).',
  FORBIDDEN:
    'The key is recognised but not allowed to do this — the Gemini API is not enabled for the project, the key is restricted, or billing is not active. Check the key’s project settings rather than replacing the key.',
  NOT_FOUND:
    'The referenced interaction or model does not exist. For a follow-up, check that the interactionId came from a completed deep_research call in this same project.',
  RATE_LIMITED:
    'Quota, not credentials. Wait before retrying and back off exponentially; do not start further research tasks in the meantime.',
  BAD_REQUEST:
    'The request was rejected as malformed. Change the arguments before retrying — the same request will fail the same way.',
  TIMEOUT:
    'Deep research routinely takes 5-20 minutes and the task may still be running upstream. Do not immediately start a second research task on the same topic; that pays for the work twice.',
  SERVICE_UNAVAILABLE:
    'A transient fault on the Gemini side. Retry once after a short wait before treating the topic as unresearchable.',
  API_ERROR: undefined,
};

/**
 * Canonical google.rpc status names, which the SDK includes verbatim in the
 * JSON error body it stringifies into `Error.message`.
 *
 * These are checked before the numeric status because they are more specific:
 * the Gemini API answers an invalid key with **400 INVALID_ARGUMENT**
 * carrying `reason: "API_KEY_INVALID"`, not with a 401, so status alone would
 * classify a bad key as a malformed request.
 */
const STATUS_NAME_CODES: ReadonlyArray<readonly [RegExp, GeminiErrorCode]> = [
  [/API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|UNAUTHENTICATED|api key not valid/i, 'INVALID_API_KEY'],
  [/PERMISSION_DENIED/, 'FORBIDDEN'],
  [/RESOURCE_EXHAUSTED/, 'RATE_LIMITED'],
  [/DEADLINE_EXCEEDED/, 'TIMEOUT'],
  [/\bUNAVAILABLE\b|\bINTERNAL\b/, 'SERVICE_UNAVAILABLE'],
  [/NOT_FOUND/, 'NOT_FOUND'],
  [/INVALID_ARGUMENT|FAILED_PRECONDITION/, 'BAD_REQUEST'],
];

function mapStatusToCode(status: number): GeminiErrorCode {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'INVALID_API_KEY';
  // 403 is PERMISSION_DENIED: the key exists but the project cannot make this
  // call. Reporting it as INVALID_API_KEY sent operators off to regenerate a
  // key that was fine, so it gets its own code — `validateApiKey()` still
  // treats it as "this key cannot be used", which is the question it asks.
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 504) return 'TIMEOUT';
  if (status >= 500) return 'SERVICE_UNAVAILABLE';
  return 'API_ERROR';
}

/**
 * Pull an HTTP status off a thrown value.
 *
 * `@google/genai` throws its own `ApiError` with a numeric `status` field
 * (`ApiError extends Error { status: number }`). Read structurally rather than
 * with `instanceof`: the same shape arrives through a mocked SDK and through a
 * re-thrown copy, and the package should not have to import a class to be able
 * to classify a number.
 */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * Last-resort textual classification, for errors that carry no status.
 *
 * Anchored deliberately. The previous implementation used
 * `message.includes('401')`, which also fires on "request took 401 ms"; here a
 * bare number only counts when it opens the message (`"429 Too Many
 * Requests"`) or is labelled as a code or status (`{"code":429`,
 * `got status: 429.`), which is how both the SDK and the REST layer phrase it.
 */
function statusFromText(message: string): number | undefined {
  const labelled = message.match(/(?:"?(?:code|status)"?\s*[:=]\s*|\bHTTP\s+)(\d{3})\b/i);
  if (labelled?.[1]) return Number(labelled[1]);
  const leading = message.match(/^\s*(\d{3})\b/);
  if (leading?.[1]) return Number(leading[1]);
  return undefined;
}

/** Timeouts surface as `AbortError`/`TimeoutError`, or as our own throw. */
function isTimeout(error: unknown, message: string): boolean {
  const name = typeof error === 'object' && error !== null ? (error as Error).name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return /\btimed?\s*out\b|\btimeout\b/i.test(message);
}

/**
 * Classify anything thrown by the Gemini SDK (or by this package) exactly once.
 *
 * Returns a `GeminiApiError` rather than a bare code so the caller gets the
 * message and the hint alongside it, and so a classified error can be
 * re-thrown and stay classified.
 */
export function classifyGeminiError(error: unknown): GeminiApiError {
  if (error instanceof GeminiApiError) return error;

  const message = error instanceof Error ? error.message : String(error);

  let code: GeminiErrorCode | undefined;
  for (const [pattern, mapped] of STATUS_NAME_CODES) {
    if (pattern.test(message)) {
      code = mapped;
      break;
    }
  }

  const status = statusOf(error) ?? statusFromText(message);
  if (!code && status !== undefined) {
    code = mapStatusToCode(status);
  }
  if (!code && isTimeout(error, message)) {
    code = 'TIMEOUT';
  }

  const resolved = code ?? 'API_ERROR';
  return new GeminiApiError(message, resolved, status, HINTS[resolved]);
}

/**
 * Does this failure mean "this API key cannot be used"?
 *
 * Both an invalid key and a key the project will not let through make the
 * configured credential unusable, and both want the operator to look at the
 * key's configuration — so `validate()` reports them the same way even though
 * the tool-call path keeps them apart.
 */
export function isCredentialProblem(code: GeminiErrorCode): boolean {
  return code === 'INVALID_API_KEY' || code === 'FORBIDDEN';
}
