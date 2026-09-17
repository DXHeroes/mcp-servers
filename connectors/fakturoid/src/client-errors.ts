/**
 * Fakturoid API error taxonomy — the documented failure codes, the error the
 * client throws, and what a caller can do about each one.
 */

export type FakturoidErrorCode =
  | 'INVALID_API_KEY'
  | 'PAYMENT_REQUIRED'
  | 'FORBIDDEN'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'UNPROCESSABLE'
  | 'API_ERROR';

export class FakturoidApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: FakturoidErrorCode,
    /** Actionable remedy for the caller, when one is known. */
    public readonly hint?: string,
  ) {
    // `message` is the bare upstream text. The code is NOT prefixed here: the
    // server reports it as its own field, and prefixing produced results like
    // `{"error":"BAD_REQUEST","message":"BAD_REQUEST: ..."}` — the code twice
    // and a message the model has to strip before it can read it.
    super(message);
    this.name = 'FakturoidApiError';
  }
}

/**
 * What the caller can do about each documented failure.
 *
 * The code alone tells a model what went wrong but not what to try next, and
 * for two of these the right next step is counter-intuitive: PAYMENT_REQUIRED
 * and FORBIDDEN both look retryable and neither is.
 */
export function hintForCode(code: FakturoidErrorCode): string | undefined {
  switch (code) {
    case 'INVALID_API_KEY':
      return 'The access token was rejected. Check the configured API key ("slug:client_id:client_secret") — the slug must match the Fakturoid account the credentials belong to.';
    case 'PAYMENT_REQUIRED':
      return 'Fakturoid has blocked the account over its own unpaid invoice; the response body lists them. No retry will help — the account owner has to settle it in Fakturoid.';
    case 'FORBIDDEN':
      return 'The credentials are fine; the account is not allowed to do this. Fakturoid documents 403 for a locked document (unlock it first), a missing bank account on the account, the subject limit being reached, and adding a payment to an invoice that is already paid. Do not re-check the API key.';
    case 'NOT_FOUND':
      return 'No record with that id in this account. Confirm the id with the matching list or search tool before retrying.';
    case 'RATE_LIMITED':
      return 'Fakturoid rate limit exceeded. The X-RateLimit-Policy and X-RateLimit response headers carry the window and what is left of it; wait for it to reset rather than retrying immediately.';
    case 'BAD_REQUEST':
      return 'Fakturoid rejected the request itself, typically a query parameter that is not a valid ISO 8601 date. Check the parameter formats rather than the values.';
    case 'UNPROCESSABLE':
      return 'The data was understood but refused. For writes the body carries an "errors" map of field to message. For a delete it means the document cannot be deleted in its current state — a proforma with a paid invoice attached, an invoice with a correction invoice, or a proforma with tax documents.';
    default:
      return undefined;
  }
}

/**
 * Fakturoid's documented 4xx meanings, one code each.
 *
 * 401 and 403 used to share `INVALID_API_KEY`, which sent callers to
 * re-check credentials that were fine. Fakturoid documents 403 for business
 * rules, not for authentication: a locked document, no bank account set on
 * the account, the subject limit reached, a payment added to an invoice that
 * is already paid. Only 401 says the token is unusable.
 *
 * 402 is real here and is not a plan upsell: Fakturoid answers 402 when the
 * account is blocked over an unpaid invoice *from Fakturoid*, and lists
 * those invoices in the body. Retrying cannot fix it.
 *
 * 422 covers both invalid data and "this document cannot be deleted"
 * (a proforma with a paid invoice attached, an invoice with a correction,
 * a proforma with tax documents).
 */
export function mapStatusToCode(status: number): FakturoidErrorCode {
  if (status === 401) return 'INVALID_API_KEY';
  if (status === 402) return 'PAYMENT_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400) return 'BAD_REQUEST';
  if (status === 422) return 'UNPROCESSABLE';
  return 'API_ERROR';
}
