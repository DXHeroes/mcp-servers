// Compare only in memory. Assertion diffs and upstream bodies can contain accounting data.

import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const company = process.env.FLEXI_INVOICE_READER_COMPANY_URL;
const credential = process.env.MCP_UPSTREAM_CREDENTIAL;
let stage = 'configuration';
const client = new Client({ name: 'flexi-reader-verification', version: '1' });
function check(condition) {
  if (!condition) throw new Error('Check failed');
}
async function call(name, args, error) {
  const result = await client.callTool({ name, arguments: args });
  check(Boolean(result.isError) === Boolean(error));
  const value = JSON.parse(result.content[0].text);
  if (error) check(value.error === error);
  return value;
}
try {
  check(/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?\/c\/[a-zA-Z0-9_-]+$/.test(company));
  check(credential?.startsWith(`${company}|`));
  stage = 'initialize';
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--stdio'],
      env: {
        FLEXI_INVOICE_READER_COMPANY_URL: company,
        MCP_UPSTREAM_CREDENTIAL: credential,
        MCP_ALLOW_PRIVATE_NETWORK_TARGETS: 'false',
      },
      stderr: 'pipe',
    }),
  );
  console.log('initialize OK', client.getServerVersion()?.version);
  stage = 'tools/list';
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  check(
    isDeepStrictEqual(names, [
      'flexi_get_issued_invoice',
      'flexi_get_received_invoice',
      'flexi_list_issued_invoices',
      'flexi_list_received_invoices',
    ]),
  );
  const authorization = `Basic ${Buffer.from(credential.slice(company.length + 1)).toString('base64')}`;
  for (const kind of ['issued', 'received']) {
    const evidence = kind === 'issued' ? 'faktura-vydana' : 'faktura-prijata';
    const list = `flexi_list_${kind}_invoices`;
    const get = `flexi_get_${kind}_invoice`;
    const fields = ['id', 'kod', 'mena', 'sumCelkem', 'sumCelkemMen', 'cisObj', 'varSym'];
    if (kind === 'received') fields.push('cisDosle');
    async function compare(name, args, suffix, params) {
      const url = new URL(`${company}/${evidence}${suffix}.json`);
      url.search = new URLSearchParams({ ...params, detail: `custom:${fields.join(',')}` });
      const response = await fetch(url, {
        headers: { authorization },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        console.error('Direct API HTTP', response.status);
        throw new Error();
      }
      const rows = (await response.json()).winstrom[evidence];
      check(Array.isArray(rows));
      const expected = rows.map((r) =>
        Object.fromEntries(fields.filter((f) => Object.hasOwn(r, f)).map((f) => [f, r[f]])),
      );
      const actual = await call(name, args);
      check(isDeepStrictEqual(actual, { [evidence]: expected }));
      return expected;
    }
    for (const start of [0, 1]) {
      stage = `${kind} page ${start}`;
      await compare(list, { limit: 1, start }, '', {
        limit: '1',
        start: String(start),
        order: 'id',
      });
    }
    stage = `${kind} missing ID`;
    const missing = process.env.FLEXI_MISSING_ID;
    if (missing) {
      check(/^[1-9][0-9]{0,15}$/.test(missing));
      const filter = `id = ${missing}`;
      check(
        (
          await compare(list, { filter }, `/(${filter})`, {
            order: 'id',
            limit: '50',
            start: '0',
          })
        ).length === 0,
      );
      await call(get, { id: missing }, 'NOT_FOUND');
    } else console.log(kind, 'empty/missing sample SKIPPED');
    const id = process.env[`FLEXI_${kind.toUpperCase()}_SAMPLE_ID`];
    stage = `${kind} synthetic invoice`;
    if (id) {
      check(/^[1-9][0-9]{0,15}$/.test(id));
      const filter = `id = ${id}`;
      const rows = await compare(list, { filter }, `/(${filter})`, {
        order: 'id',
        limit: '50',
        start: '0',
      });
      check(rows.length === 1);
      check(isDeepStrictEqual(rows, await compare(get, { id }, `/${id}`, {})));
      for (const field of fields.filter((f) => f !== 'sumCelkemMen'))
        check(rows[0][field] !== undefined && rows[0][field] !== '');
    } else console.log(kind, 'synthetic sample SKIPPED');
    await call(list, { company: 'other' }, 'INVALID_INPUT');
    await call(get, { id: 'invalid' }, 'INVALID_INPUT');
    console.log(kind, 'completed requested reads');
  }
} catch {
  console.error('Verification failed at', stage);
  process.exitCode = 1;
} finally {
  await client.close();
}
