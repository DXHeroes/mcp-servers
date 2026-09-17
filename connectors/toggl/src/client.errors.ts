/**
 * Toggl API error primitives — the error code vocabulary, the thrown error, and
 * the reconstruction of a human-readable message out of a Toggl error body.
 *
 * Split out of `client.ts` so the transport and the endpoint surface both reach
 * for the same definitions. Re-exported from `./client.js`, which stays the one
 * import path for everything about a Toggl request.
 */

export type TogglErrorCode =
  | 'INVALID_API_KEY'
  | 'PAYMENT_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'API_ERROR';

/**
 * Pulls a human-readable message out of a Toggl error body.
 *
 * Toggl is inconsistent here: some endpoints return a bare text line, some a
 * JSON string (`"Time entry not found"`), some a JSON object. Returning the
 * raw body would nest one JSON document inside the JSON string a tool result
 * is serialised into, which is what the model ends up having to read.
 */
const MESSAGE_KEYS = ['error', 'error_message', 'message', 'errors', 'detail'] as const;

/**
 * Keys that carry a message rather than naming a field of the request, so the
 * leaf fallback below does not quote them as a label.
 */
const GENERIC_MESSAGE_KEYS: ReadonlySet<string> = new Set<string>([
  ...MESSAGE_KEYS,
  'reason',
  'details',
  'data',
  'body',
  'code',
  'status',
  'title',
]);

/** Bounds on a reconstructed message: enough to act on, not a dumped body. */
const MAX_LEAF_MESSAGES = 3;
const MAX_MESSAGE_LENGTH = 300;

function messageFromJson(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = messageFromJson(item);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      if (key in record) {
        const found = messageFromJson(record[key]);
        if (found) return found;
      }
    }
    return null;
  }
  return null;
}

/**
 * Last resort: collects the leaf strings of a body whose shape we do not know.
 *
 * Toggl's field-keyed validation errors — `{"errors":{"start_date":["must not
 * be after end_date"]}}` — dead-end the walk above: `errors` is on the key
 * list, `start_date` is not. Falling back to the status text there ("Bad
 * Request") threw away the only sentence that says what is wrong, and because
 * {@link buildErrorHint} matches on the message it took the hint with it.
 *
 * Only leaf strings are taken, labelled with the field they hang under. The
 * body is never re-serialised: nesting a JSON document inside the tool result
 * is exactly what this file avoids.
 */
function collectLeafMessages(value: unknown, label: string | null, out: string[]): void {
  if (out.length >= MAX_LEAF_MESSAGES) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(label ? `${label}: ${text}` : text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeafMessages(item, label, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      // A numeric key is a position, not a field name ("0" labels nothing), so
      // the enclosing field keeps the label.
      const usable = !GENERIC_MESSAGE_KEYS.has(key.toLowerCase()) && !/^\d+$/.test(key);
      collectLeafMessages(nested, usable ? key : label, out);
    }
  }
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

export function extractErrorMessage(rawBody: string, fallback: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Plain-text body — already the message.
    return truncate(trimmed);
  }
  const known = messageFromJson(parsed);
  if (known) return truncate(known);
  const leaves: string[] = [];
  collectLeafMessages(parsed, null, leaves);
  // Only a body with no readable text at all (`[]`, `{"count":3}`) falls back
  // to the status text.
  return leaves.length > 0 ? truncate(leaves.join('; ')) : fallback;
}

export class TogglApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: TogglErrorCode,
    /** Actionable remedy for the caller, when one is known. */
    public readonly hint?: string,
  ) {
    // `message` is the bare upstream text. The code is NOT prefixed here: the
    // server reports it as a separate field, and prefixing produced results
    // like `BAD_REQUEST: "BAD_REQUEST: ..."`.
    super(message);
    this.name = 'TogglApiError';
  }
}
