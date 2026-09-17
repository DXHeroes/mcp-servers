import type { ApiKeyConfig, McpResource, McpTool, ToolAnnotations } from '@dxheroes/mcp-kit';
import { McpServer } from '@dxheroes/mcp-kit';
import type { z } from 'zod';
import {
  CREDENTIAL_FORMAT_HELP,
  DEFAULT_MAX_ROWS,
  HARD_MAX_ROWS,
  hintForCode,
  MAX_RESULT_BYTES,
  PostgresClient,
  PostgresError,
  type RunSqlOptions,
} from './client.js';
import { type ExecuteSqlInput, executeSqlSchema, type QueryInput, querySchema } from './schemas.js';

/**
 * Destructive by the MCP definition: it runs SQL the caller wrote. `classifyToolTier`
 * reads `readOnlyHint` and `destructiveHint` and nothing else, so this is also what
 * decides whether the operator's `destructive_tool_permission` applies.
 */
const DESTRUCTIVE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Advisory by the MCP spec; `runSql({ readOnly: true })` is what keeps the promise. */
const READ_ONLY_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const CONNECTION_NOTE = 'Connection details come from the gateway; never pass credentials here.';

const RESULT_HANDLING_NOTES = [
  'A cut result always says so — has_more, truncated_reason and a truncation_note that tells you what to do — so an empty rows array with has_more true does NOT mean the query matched nothing.',
  'To read more, raise max_rows, or page with ORDER BY … LIMIT … OFFSET …; when the byte allowance is what bit, return less per row instead (fewer columns, left(col, 2000), octet_length(col) in place of a large value).',
  'To find your way around the database, query the catalog: information_schema.tables / information_schema.columns for the portable view, or pg_catalog (\\d-equivalents) for PostgreSQL specifics.',
  'A statement gets 30 seconds before the call gives up with QUERY_TIMEOUT; the statement itself may still be running on the server afterwards.',
];

/**
 * Carries the operating limits as well as the warning: all danger and no
 * mechanics leaves the model to find the caps by hitting them. Facts pinned by
 * `server.test.ts`.
 */
const EXECUTE_SQL_DESCRIPTION = [
  'DESTRUCTIVE: executes arbitrary SQL on the configured PostgreSQL database.',
  'UPDATE, DELETE and DDL permanently change or drop data and cannot be undone — run the equivalent SELECT first to see what would be affected.',
  CONNECTION_NOTE,
  `Results are capped: ${DEFAULT_MAX_ROWS} rows by default, ${HARD_MAX_ROWS} at most via max_rows, and a shared ~${Math.round(MAX_RESULT_BYTES / 1000)} kB byte allowance that can cut a result well below max_rows.`,
  'Both caps are shared by the whole call, so several statements in one call divide one allowance rather than getting one each.',
  ...RESULT_HANDLING_NOTES,
].join(' ');

/** Must never claim more than PostgreSQL refuses — an operator may skip grants on it. */
const QUERY_DESCRIPTION = [
  'Runs a single read-only SQL statement against the configured PostgreSQL database and returns the rows.',
  'Read-only is enforced by PostgreSQL, not by inspecting your SQL: the statement runs inside a READ ONLY transaction, so INSERT, UPDATE, DELETE, TRUNCATE and DDL are refused on permanent tables (SQLSTATE 25006).',
  'That is PostgreSQL\u2019s own high-level notion of read-only, not a sandbox, and it does not prevent every write: COPY TO PROGRAM and pg_write_file still reach the server filesystem, and dblink writes over a connection of its own \u2014 each only for a user holding the matching privilege. A database user granted only SELECT is the boundary that actually holds.',
  'Exactly one statement per call — a second one is refused (SQLSTATE 42601) before any of them runs, so split them across calls.',
  CONNECTION_NOTE,
  `Results are capped: ${DEFAULT_MAX_ROWS} rows by default, ${HARD_MAX_ROWS} at most via max_rows, and a ~${Math.round(MAX_RESULT_BYTES / 1000)} kB byte allowance that can cut a result well below max_rows.`,
  ...RESULT_HANDLING_NOTES,
].join(' ');

function runSqlOptions(args: unknown): RunSqlOptions {
  const { sql, params, max_rows } = args as QueryInput | ExecuteSqlInput;
  return {
    sql,
    ...(params === undefined ? {} : { params }),
    maxRows: max_rows ?? DEFAULT_MAX_ROWS,
  };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (args: unknown) => Promise<unknown>;
}

interface InitError {
  code: string;
  message: string;
  hint?: string;
}

export class PostgresMcpServer extends McpServer {
  private client: PostgresClient | null = null;
  private initError: InitError | null = null;
  private toolDefs: ToolDef[] = [];

  constructor(private apiKeyConfig: ApiKeyConfig | null) {
    super();
  }

  /**
   * Never throws. A missing or malformed credential is a state the connector host asks
   * about (tools/list for the UI, a validate probe) as readily as it asks for a
   * tool call, and throwing here would turn "this server is misconfigured" into
   * a failed request with no code on it.
   */
  async initialize(): Promise<void> {
    const apiKey = this.apiKeyConfig?.apiKey;
    if (!apiKey) {
      this.initError = {
        code: 'API_KEY_REQUIRED',
        message: `No PostgreSQL connection details are configured for this MCP server. ${CREDENTIAL_FORMAT_HELP}`,
        hint: 'Add the connection details to this MCP server in the connector host. With per-user credentials, connect your own database under My Connections.',
      };
      console.warn('[Postgres] No connection details configured; tools will report the reason.');
      return;
    }
    try {
      this.client = new PostgresClient(apiKey);
      this.initError = null;
    } catch (error) {
      const mapped =
        error instanceof PostgresError
          ? {
              code: error.code,
              message: error.message,
              ...(error.hint ? { hint: error.hint } : {}),
            }
          : {
              code: 'INVALID_CREDENTIAL',
              message: error instanceof Error ? error.message : 'Unknown error',
              hint: hintForCode('INVALID_CREDENTIAL') ?? '',
            };
      this.initError = mapped;
      // The message explains the accepted formats and quotes no part of the
      // credential — that rule is enforced at `invalidCredential()` in
      // `client.ts`, which is what makes this line safe to log.
      console.warn(`[Postgres] ${mapped.message}`);
    }
  }

  override async validate(): Promise<{ valid: boolean; error?: string }> {
    const apiKey = this.apiKeyConfig?.apiKey;
    if (!apiKey) {
      return { valid: false, error: 'No PostgreSQL connection details are configured.' };
    }
    try {
      const client = new PostgresClient(apiKey);
      await client.validateCredential();
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Empty while the credential is unusable, on purpose.
   *
   * `buildToolDefs()` needs a client, and a tool that cannot run is worse than
   * no tool: the model would call it and get a configuration error back as if it
   * were a query result. The reason is not swallowed — it reaches the operator
   * through `validate()` and the boot warning, and any call reaches the model
   * through `callTool`, which answers with `initError`'s code and hint.
   */
  async listTools(): Promise<McpTool[]> {
    if (this.toolDefs.length === 0) {
      this.toolDefs = this.buildToolDefs();
    }
    return this.toolDefs.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.client) {
      const error = this.initError ?? {
        code: 'API_KEY_REQUIRED',
        message: 'No PostgreSQL connection details are configured for this MCP server.',
      };
      return this.errorResponse(error.code, error.message, error.hint);
    }

    if (this.toolDefs.length === 0) {
      this.toolDefs = this.buildToolDefs();
    }
    const def = this.toolDefs.find((tool) => tool.name === name);
    if (!def) {
      return this.errorResponse(
        'UNKNOWN_TOOL',
        `Unknown tool: ${name}`,
        `This server provides: ${this.toolDefs.map((tool) => tool.name).join(', ')}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = def.inputSchema.parse(args ?? {});
    } catch (error) {
      const issues =
        error instanceof Error && 'issues' in error
          ? (error as { issues: { path: (string | number | symbol)[]; message: string }[] }).issues
          : [];
      return this.errorResponse(
        'INVALID_INPUT',
        'Input does not match the tool schema.',
        undefined,
        {
          details: issues.map((issue) => ({
            path: issue.path.map((segment) => String(segment)).join('.'),
            message: issue.message,
          })),
        },
      );
    }

    try {
      const result = await def.handler(parsed);
      return {
        content: [{ type: 'text', text: JSON.stringify(this.successPayload(def.name, result)) }],
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listResources(): Promise<McpResource[]> {
    return [];
  }

  async readResource(uri: string): Promise<unknown> {
    throw new Error(`Resources are not supported by this MCP server: ${uri}`);
  }

  /**
   * `JSON.stringify(undefined)` is `undefined`, which drops the `text` key and
   * leaves the caller with a content block that has no content. A handler that
   * returned nothing therefore gets a payload that says so, in words the model
   * can act on.
   *
   * The wording is derived from the tool's own annotation, per the house
   * template: what an empty result means depends on whether the tool reads or
   * writes, and only the package knows which. It used to be hardcoded to the
   * read wording — "treat the outcome as unknown … run the statement again" —
   * for a package whose only tool is a write. On this tool that advice is
   * actively harmful: re-running an INSERT inserts twice, and re-running an
   * UPDATE that has already been applied can overwrite a value corrected in
   * between. A write with no reported result has to be **verified**, not
   * repeated.
   *
   * `null` passes through untouched: it is valid JSON and a real answer.
   */
  private successPayload(tool: string, result: unknown): unknown {
    if (result !== undefined) return result;
    const isRead =
      this.toolDefs.find((def) => def.name === tool)?.annotations.readOnlyHint === true;
    if (isRead) {
      return {
        success: false,
        tool,
        message:
          'The query finished but produced no result object. Treat the outcome as unknown — it does NOT mean zero rows, which is reported as an empty `rows` array with `row_count: 0` — and run the statement again or check the database directly.',
      };
    }
    return {
      success: false,
      tool,
      message:
        'The statement finished but produced no result object, so whether it took effect is unknown. It may well have been applied — do NOT simply run it again, because an INSERT would then insert twice and an UPDATE could overwrite a value corrected in between. Verify with a SELECT first, and re-run only if that shows the change is missing.',
    };
  }

  private errorResponse(
    error: string,
    message: string,
    hint?: string,
    extra?: Record<string, unknown>,
  ) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error,
            message,
            ...(hint ? { hint } : {}),
            ...(extra ?? {}),
          }),
        },
      ],
      isError: true,
    };
  }

  private handleError(error: unknown) {
    if (error instanceof PostgresError) {
      // `error.message` is the bare (already scrubbed) upstream text — the code
      // travels in its own field, so it must not be prefixed onto the message.
      return this.errorResponse(
        error.code,
        error.message,
        error.hint,
        error.sqlstate === undefined ? undefined : { sqlstate: error.sqlstate },
      );
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return this.errorResponse('PG_ERROR', message);
  }

  private buildToolDefs(): ToolDef[] {
    const client = this.client;
    if (!client) return [];
    return [
      {
        name: 'postgres_query',
        description: QUERY_DESCRIPTION,
        inputSchema: querySchema,
        annotations: READ_ONLY_TOOL,
        handler: async (args: unknown) => client.runSql({ ...runSqlOptions(args), readOnly: true }),
      },
      {
        name: 'postgres_execute_sql',
        description: EXECUTE_SQL_DESCRIPTION,
        inputSchema: executeSqlSchema,
        annotations: DESTRUCTIVE_TOOL,
        handler: async (args: unknown) => client.runSql(runSqlOptions(args)),
      },
    ];
  }
}
