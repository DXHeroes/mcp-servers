/**
 * `PostgresMcpServer` — the tool surface, its annotations, and every path that
 * produces a content block.
 *
 * The client is mocked, so what is under test is the wiring: which code a
 * failure is reported under, that a response always carries text, and that the
 * credential never reaches the caller. Credential parsing, the network policy
 * and result shaping are covered in the `client.*.test.ts` files.
 */
import type { ApiKeyConfig } from '@dxheroes/mcp-kit';
import { classifyToolTier } from '@dxheroes/mcp-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/** Just enough of the emitted JSON Schema to assert on it without casts. */
interface JsonSchemaShape {
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, { type?: string; description?: string } | undefined>;
}

const { clientState } = vi.hoisted(() => ({
  clientState: {
    /** Thrown by the mocked constructor when set — stands in for a bad credential. */
    constructorError: null as unknown,
    runSql: vi.fn<(options: unknown) => Promise<unknown>>(),
    validateCredential: vi.fn<() => Promise<void>>(),
  },
}));

vi.mock('../src/client.js', async (importOriginal) => {
  // `importOriginal` keeps the real `PostgresError`, so `instanceof` in the
  // server still works and the codes under test are the real ones.
  const original = await importOriginal<typeof import('../src/client.js')>();
  return {
    ...original,
    PostgresClient: class {
      constructor(_credential: string) {
        if (clientState.constructorError) throw clientState.constructorError;
      }
      runSql(options: unknown): Promise<unknown> {
        return clientState.runSql(options);
      }
      validateCredential(): Promise<void> {
        return clientState.validateCredential();
      }
    },
  };
});

const { PostgresError } = await import('../src/client.js');
const { PostgresMcpServer } = await import('../src/server.js');

const CREDENTIAL = 'postgresql://alice:sup3rsecret@db.example.com/shop';

function apiKeyConfig(apiKey = CREDENTIAL): ApiKeyConfig {
  return { apiKey, headerName: 'Authorization', headerValue: `Bearer ${apiKey}` };
}

interface ToolResponse {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const typed = result as ToolResponse;
  // An empty body must not be able to drop the `text` key.
  expect(typeof typed.content[0]?.text).toBe('string');
  return JSON.parse(typed.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function serverWith(config: ApiKeyConfig | null) {
  const server = new PostgresMcpServer(config);
  await server.initialize();
  return server;
}

async function tools() {
  return (await serverWith(apiKeyConfig())).listTools();
}

/** By name, never by index: the surface is no longer a single tool. */
async function toolNamed(name: string) {
  const tool = (await tools()).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`No such tool: ${name}`);
  return tool;
}

beforeEach(() => {
  clientState.constructorError = null;
  clientState.runSql.mockReset();
  clientState.runSql.mockResolvedValue({
    command: 'SELECT',
    row_count: 0,
    returned: 0,
    has_more: false,
    fields: [],
    rows: [],
  });
  clientState.validateCredential.mockReset();
  clientState.validateCredential.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('tool surface', () => {
  it('exposes the read tool and the write tool, read first', async () => {
    expect((await tools()).map((tool) => tool.name)).toEqual([
      'postgres_query',
      'postgres_execute_sql',
    ]);
  });

  it('emits the input schema the model is expected to obey', async () => {
    const tool = await toolNamed('postgres_execute_sql');
    // What reaches the model is the emitted JSON Schema, so that is what is pinned.
    const emitted = z.toJSONSchema(tool.inputSchema as z.ZodType) as JsonSchemaShape;

    expect(emitted.required).toEqual(['sql']);
    // Zod emits this for a *stripping* object too, so it does not pin `.strict()`
    // itself — the unknown-key cases in `callTool` below do.
    expect(emitted.additionalProperties).toBe(false);
    expect(emitted.properties?.max_rows).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    });
    expect(emitted.properties?.sql).toMatchObject({ type: 'string', minLength: 1 });
    // The `.describe()` strings are the model's only per-field guidance.
    expect(emitted.properties?.sql?.description).toContain('$1, $2');
    expect(emitted.properties?.params?.description).toContain('never parsed as SQL');
    expect(emitted.properties?.max_rows?.description).toContain('1000');
  });

  it('tells the model how to operate EVERY tool, not only what it risks', async () => {
    for (const tool of await tools()) {
      const description = tool.description ?? '';
      for (const fact of [
        'max_rows',
        'OFFSET',
        'has_more',
        'does NOT mean the query matched nothing',
        '256 kB',
        'information_schema',
        'pg_catalog',
        '30 seconds',
        'never pass credentials here',
      ]) {
        expect(description, `${tool.name}: ${fact}`).toContain(fact);
      }
    }
  });

  it('states the write tool\u2019s own risks', async () => {
    const description = (await toolNamed('postgres_execute_sql')).description ?? '';
    for (const fact of ['DESTRUCTIVE', 'cannot be undone', 'shared by the whole call']) {
      expect(description, fact).toContain(fact);
    }
  });

  it('provides no resources', async () => {
    const server = await serverWith(apiKeyConfig());
    await expect(server.listResources()).resolves.toEqual([]);
    await expect(server.readResource('pg://anything')).rejects.toThrow();
  });
});

describe('tool annotations', () => {
  it('annotates every tool with a boolean readOnlyHint', async () => {
    for (const tool of await tools()) {
      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
    }
  });

  it('pins the tier partition: 1 read-only, 0 additive writes, 1 destructive', async () => {
    const all = await tools();
    const readOnly = all.filter((tool) => tool.annotations?.readOnlyHint === true);
    const destructive = all.filter(
      (tool) =>
        tool.annotations?.readOnlyHint !== true && tool.annotations?.destructiveHint === true,
    );
    const additiveWrites = all.filter(
      (tool) =>
        tool.annotations?.readOnlyHint !== true && tool.annotations?.destructiveHint !== true,
    );
    expect(readOnly).toHaveLength(1);
    expect(additiveWrites).toHaveLength(0);
    expect(destructive).toHaveLength(1);
    expect(readOnly.length + destructive.length).toBe(all.length);
  });

  it('puts the read tool in the read-only tier, which is what the operator switch keys on', async () => {
    const query = await toolNamed('postgres_query');
    expect(query.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(classifyToolTier(query.annotations)).toBe('read-only');
    expect(classifyToolTier((await toolNamed('postgres_execute_sql')).annotations)).toBe(
      'destructive',
    );
  });

  it('says the read tool is enforced, and states the limits instead of claiming a sandbox', async () => {
    const description = (await toolNamed('postgres_query')).description ?? '';
    // `temporary tables` is absent on purpose: unreachable here, so naming it
    // would overclaim the other way.
    for (const fact of [
      'enforced by PostgreSQL',
      'READ ONLY transaction',
      '25006',
      'Exactly one statement per call',
      '42601',
      'permanent tables',
      'COPY TO PROGRAM',
      'pg_write_file',
      'dblink',
      'granted only SELECT',
    ]) {
      expect(description, fact).toContain(fact);
    }
    expect(description).not.toContain('DESTRUCTIVE');
    expect(description).not.toContain('nothing is written');
  });

  it('marks the destructive tool DESTRUCTIVE in its description', async () => {
    for (const tool of await tools()) {
      if (tool.annotations?.destructiveHint !== true) continue;
      expect(tool.description).toContain('DESTRUCTIVE');
      expect(tool.description).toMatch(/SELECT/);
    }
  });

  it('never marks a destructive tool read-only', async () => {
    for (const tool of await tools()) {
      if (tool.annotations?.destructiveHint === true) {
        expect(tool.annotations.readOnlyHint).toBe(false);
      }
    }
  });

  it('does not claim idempotence for a tool that runs INSERT', async () => {
    const write = await toolNamed('postgres_execute_sql');
    expect(write.annotations?.idempotentHint).toBe(false);
    expect(write.annotations?.openWorldHint).toBe(true);
  });
});

describe('credential state', () => {
  it('reports a missing credential as API_KEY_REQUIRED without throwing', async () => {
    const server = await serverWith(null);
    const payload = payloadOf(await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' }));
    expect(payload.error).toBe('API_KEY_REQUIRED');
    expect(payload.hint).toBeTruthy();
  });

  it('reports a malformed credential as INVALID_CREDENTIAL without throwing', async () => {
    clientState.constructorError = new PostgresError(
      'The connection details match neither accepted form.',
      'INVALID_CREDENTIAL',
      'Fix the stored connection details.',
    );
    const server = await serverWith(apiKeyConfig('nonsense'));
    const result = (await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toBe('INVALID_CREDENTIAL');
  });

  it('lists no tools when the credential is unusable', async () => {
    const server = await serverWith(null);
    await expect(server.listTools()).resolves.toEqual([]);
  });

  it('validate() reports success and failure without throwing', async () => {
    await expect((await serverWith(apiKeyConfig())).validate()).resolves.toEqual({ valid: true });

    clientState.validateCredential.mockRejectedValue(
      new PostgresError(
        'password authentication failed',
        'AUTH_FAILED',
        'Check the user.',
        '28P01',
      ),
    );
    const failed = await (await serverWith(apiKeyConfig())).validate();
    expect(failed.valid).toBe(false);
    expect(failed.error).toContain('authentication failed');

    await expect((await serverWith(null)).validate()).resolves.toMatchObject({ valid: false });
  });
});

describe('callTool', () => {
  it('returns the client result as text', async () => {
    clientState.runSql.mockResolvedValue({
      command: 'SELECT',
      row_count: 1,
      returned: 1,
      has_more: false,
      fields: [{ name: 'id', data_type_id: 23 }],
      rows: [{ id: 1 }],
    });
    const server = await serverWith(apiKeyConfig());
    const payload = payloadOf(await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' }));
    expect(payload).toMatchObject({ command: 'SELECT', row_count: 1, returned: 1 });
  });

  it('passes sql, params and the row limit through to the client', async () => {
    const server = await serverWith(apiKeyConfig());
    await server.callTool('postgres_execute_sql', {
      sql: 'SELECT * FROM t WHERE a = $1',
      params: ['x'],
      max_rows: 5,
    });
    expect(clientState.runSql).toHaveBeenCalledWith({
      sql: 'SELECT * FROM t WHERE a = $1',
      params: ['x'],
      maxRows: 5,
    });
  });

  it('defaults the row limit when the caller omits it', async () => {
    const server = await serverWith(apiKeyConfig());
    await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' });
    expect(clientState.runSql).toHaveBeenCalledWith({ sql: 'SELECT 1', maxRows: 200 });
  });

  it('asks the client for read-only execution on postgres_query, and only there', async () => {
    const server = await serverWith(apiKeyConfig());
    await server.callTool('postgres_query', {
      sql: 'SELECT * FROM t WHERE a = $1',
      params: ['x'],
      max_rows: 5,
    });
    // `readOnly: true` is the whole enforcement; the annotation is advisory.
    expect(clientState.runSql).toHaveBeenCalledWith({
      sql: 'SELECT * FROM t WHERE a = $1',
      params: ['x'],
      maxRows: 5,
      readOnly: true,
    });

    clientState.runSql.mockClear();
    await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' });
    expect(clientState.runSql).toHaveBeenCalledWith({ sql: 'SELECT 1', maxRows: 200 });
  });

  it('gives the read tool the read wording when a call produces no result', async () => {
    clientState.runSql.mockResolvedValue(undefined);
    const server = await serverWith(apiKeyConfig());
    const payload = payloadOf(await server.callTool('postgres_query', { sql: 'SELECT 1' }));
    expect(payload.tool).toBe('postgres_query');
    expect(String(payload.message)).toContain('run the statement again');
  });

  it('keeps a text block when the handler returns nothing', async () => {
    clientState.runSql.mockResolvedValue(undefined);
    const server = await serverWith(apiKeyConfig());
    const payload = payloadOf(await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' }));
    expect(payload.success).toBe(false);
    expect(payload.tool).toBe('postgres_execute_sql');
    expect(String(payload.message)).toContain('unknown');
  });

  it('rejects an unknown tool with UNKNOWN_TOOL', async () => {
    const server = await serverWith(apiKeyConfig());
    const payload = payloadOf(await server.callTool('postgres_list_tables', {}));
    expect(payload.error).toBe('UNKNOWN_TOOL');
    expect(String(payload.hint)).toContain('postgres_execute_sql');
  });

  const invalidInputs: [string, unknown][] = [
    ['missing sql', {}],
    ['empty sql', { sql: '' }],
    ['sql of the wrong type', { sql: 42 }],
    ['max_rows below the range', { sql: 'SELECT 1', max_rows: 0 }],
    ['max_rows above the range', { sql: 'SELECT 1', max_rows: 2000 }],
    ['fractional max_rows', { sql: 'SELECT 1', max_rows: 1.5 }],
    ['a non-scalar parameter', { sql: 'SELECT 1', params: [{ nested: true }] }],
    ['no arguments at all', undefined],
    // Zod strips unknown keys by default, so without `.strict()` these are
    // accepted and silently ignored.
    ['a plausible wrong name for max_rows', { sql: 'SELECT 1', limit: 500 }],
    ['a camelCase max_rows', { sql: 'SELECT 1', maxRows: 500 }],
    ['a connection field the tool does not take', { sql: 'SELECT 1', host: 'evil.example.com' }],
  ];

  for (const [label, args] of invalidInputs) {
    it(`rejects ${label} with INVALID_INPUT and details`, async () => {
      const server = await serverWith(apiKeyConfig());
      const payload = payloadOf(await server.callTool('postgres_execute_sql', args));
      expect(payload.error).toBe('INVALID_INPUT');
      expect(Array.isArray(payload.details)).toBe(true);
      expect((payload.details as unknown[]).length).toBeGreaterThan(0);
      expect(clientState.runSql).not.toHaveBeenCalled();
    });
  }

  it('names the unknown key so the model can correct it in one retry', async () => {
    const server = await serverWith(apiKeyConfig());
    const payload = payloadOf(
      await server.callTool('postgres_execute_sql', { sql: 'SELECT 1', limit: 500 }),
    );
    expect(JSON.stringify(payload.details)).toContain('limit');
  });
});

describe('error responses', () => {
  it('reports the code as its own field, never as a prefix on the message', async () => {
    clientState.runSql.mockRejectedValue(
      new PostgresError('syntax error at or near "SELCT"', 'SQL_ERROR', 'Fix the SQL.', '42601'),
    );
    const server = await serverWith(apiKeyConfig());
    const result = (await server.callTool('postgres_execute_sql', { sql: 'SELCT 1' })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.error).toBe('SQL_ERROR');
    expect(String(payload.message)).toBe('syntax error at or near "SELCT"');
    expect(String(payload.message).startsWith('SQL_ERROR')).toBe(false);
    expect(payload.sqlstate).toBe('42601');
    expect(payload.hint).toBe('Fix the SQL.');
  });

  it('omits sqlstate when PostgreSQL did not give one', async () => {
    clientState.runSql.mockRejectedValue(
      new PostgresError('connect ECONNREFUSED', 'CONNECTION_FAILED', 'Check the host.'),
    );
    const server = await serverWith(apiKeyConfig());
    const payload = payloadOf(await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' }));
    expect(payload.error).toBe('CONNECTION_FAILED');
    expect(payload).not.toHaveProperty('sqlstate');
  });

  it('falls back to PG_ERROR for a non-package error', async () => {
    clientState.runSql.mockRejectedValue(new Error('something unexpected'));
    const server = await serverWith(apiKeyConfig());
    const payload = payloadOf(await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' }));
    expect(payload.error).toBe('PG_ERROR');
  });

  it('keeps text on every error path', async () => {
    const server = await serverWith(apiKeyConfig());
    const cases: (() => Promise<unknown>)[] = [
      () => server.callTool('nope', {}),
      () => server.callTool('postgres_execute_sql', {}),
      () => {
        clientState.runSql.mockRejectedValue(new PostgresError('boom', 'PG_ERROR'));
        return server.callTool('postgres_execute_sql', { sql: 'SELECT 1' });
      },
    ];
    for (const run of cases) {
      const result = (await run()) as ToolResponse;
      expect(typeof result.content[0]?.text).toBe('string');
      expect(result.isError).toBe(true);
    }
  });
});

describe('a handler that reports nothing', () => {
  it('tells the model to verify a write rather than repeat it', async () => {
    clientState.runSql.mockResolvedValue(undefined);
    const server = await serverWith(apiKeyConfig());
    const result = (await server.callTool('postgres_execute_sql', {
      sql: "INSERT INTO t (a) VALUES ('x')",
    })) as ToolResponse;

    // An empty result must not be able to drop the `text` key.
    expect(typeof result.content[0]?.text).toBe('string');
    const payload = payloadOf(result);
    // Re-running an INSERT inserts twice, so the write path must not say so.
    expect(String(payload.message)).toContain('do NOT simply run it again');
    expect(String(payload.message)).toContain('Verify with a SELECT');
    expect(String(payload.message)).not.toContain('run the statement again');
  });
});

describe('the credential never leaves the connector host', () => {
  it('is absent from an error response even when the underlying error quotes it', async () => {
    // The client scrubs before throwing; the server must not reintroduce it.
    clientState.runSql.mockRejectedValue(
      new PostgresError('failed for [REDACTED-SECRET]', 'PG_ERROR'),
    );
    const server = await serverWith(apiKeyConfig());
    const result = (await server.callTool('postgres_execute_sql', { sql: 'SELECT 1' })) as {
      content: { text?: string }[];
    };
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('sup3rsecret');
    expect(text).not.toContain(CREDENTIAL);
  });

  it('is absent from the whole tool surface shown to the model', async () => {
    const tools = await (await serverWith(apiKeyConfig())).listTools();
    // The generated JSON Schema and the annotations reach the model too, so the
    // name and description alone are not the surface worth checking.
    const surface = JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        schema: z.toJSONSchema(tool.inputSchema as z.ZodType),
      })),
    );

    expect(surface).not.toContain('sup3rsecret');
    expect(surface).not.toContain('alice');
    expect(surface).not.toContain('db.example.com');
    expect(surface).not.toContain(CREDENTIAL);
  });
});
