/**
 * This package's error type, its codes, the hints that go with them, and the
 * shape-reading that tells a SQLSTATE from a Node errno.
 */
import { STATEMENT_TIMEOUT_MS } from './limits.js';

/**
 * Error codes this package reports. The code travels in its own field of the
 * error response; it is never prefixed onto the message.
 */
export type PostgresErrorCode =
  | 'INVALID_CREDENTIAL'
  | 'BLOCKED_TARGET'
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'QUERY_TIMEOUT'
  | 'SQL_ERROR'
  | 'PG_ERROR';

export class PostgresError extends Error {
  constructor(
    message: string,
    public readonly code: PostgresErrorCode,
    /** Actionable remedy for the caller, when one is known. */
    public readonly hint?: string,
    /** PostgreSQL SQLSTATE, when the server produced one. */
    public readonly sqlstate?: string,
  ) {
    // `message` is the bare (scrubbed) upstream text. The code is NOT prefixed
    // here: the server reports it as a separate field, and prefixing produces
    // results like `{"error":"SQL_ERROR","message":"SQL_ERROR: ..."}`.
    super(message);
    this.name = 'PostgresError';
  }
}

/** Actionable remedy for the codes where the message alone leaves the caller stuck. */
export function hintForCode(code: PostgresErrorCode): string | undefined {
  switch (code) {
    case 'INVALID_CREDENTIAL':
      return 'Fix the stored connection details for this MCP server in the connector host. The tool call itself never carries them.';
    case 'BLOCKED_TARGET':
      return 'this connector host refuses MCP targets on private networks (MCP_ALLOW_PRIVATE_NETWORK_TARGETS=false). Link-local and unspecified addresses are refused regardless of that setting. Use a database the connector host is allowed to reach, or ask the operator to change the policy.';
    case 'CONNECTION_FAILED':
      return 'The database did not answer. Check host, port, and that the connector host can reach it through the network.';
    case 'AUTH_FAILED':
      return 'PostgreSQL rejected the credentials. Check the user and password in the stored connection details, and that pg_hba.conf admits this user from the connector host.';
    case 'QUERY_TIMEOUT':
      return `The statement exceeded the ${STATEMENT_TIMEOUT_MS / 1000}s budget for a tool call. It may still be running on the server: the connector host stopped waiting for it and sends no cancel request, and statement_timeout is a session setting that SQL in the call itself can turn off. Narrow the query (add a WHERE clause or a LIMIT) or run it in smaller batches; to stop the statement itself, cancel it in the database (pg_cancel_backend).`;
    case 'SQL_ERROR':
      return 'PostgreSQL rejected the statement itself. Read the message for the position and the SQLSTATE, then fix the SQL.';
    default:
      return undefined;
  }
}

/**
 * `pg` puts two unrelated things in `error.code`: a PostgreSQL SQLSTATE for a
 * server error, and a Node errno for a socket or TLS failure.
 *
 * They are told apart by shape rather than by length: `EPIPE` is also five
 * characters and would otherwise pass for a SQLSTATE. Every SQLSTATE contains
 * at least one digit (`28P01`, `57014`, `XX000`); no errno does.
 */
export function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z_]*$/.test(code) ? code : undefined;
}

export function sqlstateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code)
    ? code
    : undefined;
}

export const CONNECTION_ERRNOS = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EPROTO',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** Collects the raw text `pg` may have hidden the credential in. */
export function pgErrorText(error: unknown): string {
  const e = error as Record<string, unknown> | null;
  const parts = [e?.message, e?.detail, e?.hint, e?.where]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' — ');
  return parts === '' ? 'Unknown PostgreSQL error' : parts;
}
