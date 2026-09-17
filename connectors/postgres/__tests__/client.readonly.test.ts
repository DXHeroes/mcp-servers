/**
 * `PostgresClient` — what the package *sends* for `runSql({ readOnly: true })`.
 * Whether PostgreSQL then refuses the write is a fact a mock would decide for
 * itself, so it is settled in `integration/real-database.safety.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDnsMock,
  createPgMock,
  loadClient,
  PUBLIC_URL,
  pgState,
  setupHarness,
} from './client.harness.js';

vi.mock('pg', () => createPgMock());
vi.mock('node:dns/promises', () => createDnsMock());

const { PostgresClient } = await loadClient();

setupHarness();

const okSelect = () => ({ command: 'SELECT', rowCount: 1, rows: [{ id: 1 }], fields: [] });
const run = (options: Parameters<InstanceType<typeof PostgresClient>['runSql']>[0]) =>
  new PostgresClient(PUBLIC_URL).runSql(options);
const texts = () => pgState.queryConfigs.map((query) => query.text);

describe('read-only execution', () => {
  it('opens a READ ONLY transaction, then runs the one statement on the extended protocol', async () => {
    pgState.query.mockResolvedValue(okSelect());
    const result = await run({ sql: 'SELECT 1', readOnly: true });
    // Order matters: a preamble sent after the statement enforces nothing.
    expect(texts()).toEqual(['BEGIN READ ONLY', 'SELECT 1']);
    expect(pgState.queryConfigs.at(-1)?.values).toBeUndefined();
    expect(pgState.queryConfigs.at(-1)?.queryMode).toBe('extended');
    expect(result).not.toHaveProperty('statements');
    expect(result).toMatchObject({ command: 'SELECT', returned: 1 });
  });

  it('keeps parameters working alongside it', async () => {
    pgState.query.mockResolvedValue(okSelect());
    await run({ sql: 'SELECT * FROM t WHERE a = $1', params: ['x'], readOnly: true });
    expect(pgState.queryConfigs.at(-1)).toMatchObject({
      text: 'SELECT * FROM t WHERE a = $1',
      values: ['x'],
      queryMode: 'extended',
    });
  });

  it('changes nothing about the read-write path', async () => {
    pgState.query.mockResolvedValue(okSelect());
    await run({ sql: 'DELETE FROM t' });
    expect(texts()).toEqual(['DELETE FROM t']);
    // Absent, not merely "not extended": the write path's config is unchanged.
    expect(pgState.queryConfigs[0]).not.toHaveProperty('queryMode');
  });

  it('spends none of the caller’s row budget on the preamble', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    pgState.query.mockResolvedValue({ command: 'SELECT', rowCount: 5, rows, fields: [] });
    const result = (await run({ sql: 'SELECT 1', maxRows: 5, readOnly: true })) as {
      returned: number;
      has_more: boolean;
    };
    expect(result.returned).toBe(5);
    expect(result.has_more).toBe(false);
  });
});
