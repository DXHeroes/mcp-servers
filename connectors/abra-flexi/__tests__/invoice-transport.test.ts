import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';

async function connect(company: string, reader?: string, creator?: string) {
  const client = new Client({ name: 'invoice-acceptance', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--stdio'],
      env: {
        MCP_UPSTREAM_CREDENTIAL: `${company}|fixture:synthetic`,
        ...(creator === undefined ? {} : { FLEXI_INVOICE_CREATOR_COMPANY_URL: creator }),
        ...(reader === undefined ? {} : { FLEXI_INVOICE_READER_COMPANY_URL: reader }),
      },
      stderr: 'pipe',
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content[0];
  if (content?.type !== 'text') throw new Error('Missing tool response');
  return { error: result.isError === true, data: JSON.parse(content.text) };
}

it('reads projected invoices over stdio and round-trips independent document numbers in the full profile', async () => {
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  const requests: string[] = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    requests.push(url.pathname);
    const route = /^\/c\/fixture\/(faktura-vydana|faktura-prijata)(?:\/([^/]+))?\.json$/.exec(
      decodeURIComponent(url.pathname),
    );
    if (
      !route ||
      req.headers.authorization !== `Basic ${Buffer.from('fixture:synthetic').toString('base64')}`
    ) {
      res.writeHead(403).end('PRIVATE');
      return;
    }
    const [, evidence, selector] = route;
    const rows = records.get(evidence!) ?? new Map<string, Record<string, unknown>>();
    records.set(evidence!, rows);
    if (req.method !== 'GET') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const fields = JSON.parse(body).winstrom[evidence!];
      const key = selector ?? fields.id;
      const previous = rows.get(key);
      if (fields['@update'] === 'fail') {
        if (previous || fields.datVyst === '2000-01-01') {
          res.writeHead(400).end('PRIVATE');
          return;
        }
        if (fields.popis === 'unknown outcome') {
          res.end();
          return;
        }
        rows.set(key, { ...fields, id: rows.size + 1 });
        res.end(
          JSON.stringify({
            winstrom: { success: 'true', stats: { created: '1', updated: '0', deleted: '0' } },
          }),
        );
        return;
      }
      rows.set(key, { ...previous, ...fields, id: previous?.id ?? rows.size + 1 });
      res.end(JSON.stringify({ winstrom: { success: true } }));
      return;
    }
    const projection = url.searchParams.get('detail');
    if (projection) {
      const fields = ['id', 'kod', 'mena', 'sumCelkem', 'sumCelkemMen', 'varSym', 'cisObj'];
      if (evidence === 'faktura-prijata') fields.push('cisDosle');
      if (
        projection !== `custom:${fields.join(',')}` ||
        (!selector && url.searchParams.get('order') !== 'id')
      ) {
        res.writeHead(400).end('Unexpected projection or order');
        return;
      }
    }
    let page = [...rows.values()];
    if (selector === '404') {
      res.writeHead(404).end('PRIVATE');
      return;
    }
    if (selector === '500') {
      res.end(
        JSON.stringify({ winstrom: { [evidence!]: [{ id: 500, mena: { secret: 'PRIVATE' } }] } }),
      );
      return;
    }
    if (selector) {
      const filter = /^\(id = (\d+)\)$/.exec(selector);
      page = page.filter((row) => String(row.id) === (filter?.[1] ?? selector));
    }
    const start = Number(url.searchParams.get('start') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    res.end(
      JSON.stringify({
        winstrom: {
          [evidence!]: page
            .slice(start, start + limit)
            .map((r) => ({ ...r, poznam: 'PRIVATE', prilohy: [{ obsah: 'PRIVATE' }] })),
        },
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const company = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/c/fixture`;
  const clients: Client[] = [];
  try {
    const writer = await connect(company);
    clients.push(writer);
    const reader = await connect(company, company);
    clients.push(reader);
    const mismatch = await connect(company, `${company}2`);
    clients.push(mismatch);
    expect((await mismatch.listTools()).tools).toHaveLength(0);
    expect((await writer.listTools()).tools).toHaveLength(30);
    expect((await reader.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'flexi_get_issued_invoice',
      'flexi_get_received_invoice',
      'flexi_list_issued_invoices',
      'flexi_list_received_invoices',
    ]);
    const creator = await connect(company, undefined, company);
    clients.push(creator);
    expect((await creator.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'flexi_create_issued_invoice',
      'flexi_create_received_invoice',
      'flexi_get_issued_invoice',
      'flexi_get_received_invoice',
      'flexi_list_issued_invoices',
      'flexi_list_received_invoices',
    ]);
    const both = await connect(company, company, company);
    clients.push(both);
    expect((await both.listTools()).tools).toHaveLength(4);
    for (const kind of ['issued', 'received']) {
      const evidence = kind === 'issued' ? 'faktura-vydana' : 'faktura-prijata';
      const rows = new Map<string, Record<string, unknown>>();
      records.set(evidence, rows);
      const external = 'ext:fixture:sample';
      const numbers = {
        cisObj: 'ORD-03',
        varSym: '00001234',
        ...(kind === 'received' ? { cisDosle: 'SUP-77' } : {}),
      };
      const input = { id: external, firma: 'code:TEST', mena: 'code:EUR', ...numbers };
      const create = `flexi_create_${kind}_invoice`;
      const get = `flexi_get_${kind}_invoice`;
      const list = `flexi_list_${kind}_invoices`;
      const restricted = {
        ...input,
        id: 'ext:fixture:scoped',
        typDokl: 'code:TEST',
        polozkyFaktury: [{ nazev: 'Sample', cenaMj: 1 }],
      };
      expect((await call(creator, create, restricted)).data).toEqual({
        created: true,
        externalId: restricted.id,
      });
      expect(
        (
          await call(creator, create, {
            ...restricted,
            polozkyFaktury: [{ nazev: 'Sample', cenaMj: 2 }],
          })
        ).error,
      ).toBe(true);
      expect(rows.get(restricted.id)?.polozkyFaktury).toEqual(restricted.polozkyFaktury);
      expect(
        (
          await call(creator, create, {
            ...restricted,
            id: 'ext:fixture:locked',
            datVyst: '2000-01-01',
          })
        ).data.error,
      ).toBe('BAD_REQUEST');
      expect(
        (
          await call(creator, create, {
            ...restricted,
            id: 'ext:fixture:unknown',
            popis: 'unknown outcome',
          })
        ).data.error,
      ).toBe('UNCONFIRMED_WRITE');
      expect((await call(creator, create, { ...restricted, '@update': 'ok' })).error).toBe(true);
      expect(rows.size).toBe(1);
      rows.clear();
      for (let repeat = 0; repeat < 2; repeat++)
        expect((await call(writer, create, input)).error).toBe(false);
      expect(rows.size).toBe(1);
      expect((await call(writer, get, { id: 1 })).data[evidence][0]).toMatchObject(numbers);
      for (let repeat = 0; repeat < 2; repeat++)
        expect(
          (await call(writer, `flexi_update_${kind}_invoice`, { id: external, cisObj: 'ORD-04' }))
            .error,
        ).toBe(false);
      expect(rows.size).toBe(1);
      const expected = {
        id: 1,
        kod: 'SYN-1',
        sumCelkem: '249.50',
        sumCelkemMen: '10.00',
        mena: 'code:EUR',
        ...numbers,
        cisObj: 'ORD-04',
      };
      Object.assign(rows.get(external)!, {
        kod: expected.kod,
        sumCelkem: expected.sumCelkem,
        sumCelkemMen: expected.sumCelkemMen,
      });
      rows.set('second', { ...expected, id: 2 });
      const detail = (await call(reader, get, { id: 1 })).data;
      expect(detail).toEqual({ [evidence]: [expected] });
      const rest = await fetch(`${company}/${evidence}/1.json`, {
        headers: { Authorization: `Basic ${Buffer.from('fixture:synthetic').toString('base64')}` },
      });
      expect(rest.ok).toBe(true);
      const raw = (await rest.json()).winstrom[evidence][0];
      expect(Object.fromEntries(Object.keys(expected).map((field) => [field, raw[field]]))).toEqual(
        detail[evidence][0],
      );
      expect((await call(reader, list, { filter: 'id = 1' })).data).toEqual(detail);
      expect((await call(reader, list, { limit: 1, start: 1 })).data).toEqual({
        [evidence]: [{ ...expected, id: 2 }],
      });
      expect((await call(reader, list, { filter: 'id = 99' })).data).toEqual({ [evidence]: [] });
      expect((await call(reader, get, { id: 404 })).data.error).toBe('NOT_FOUND');
      const malformed = await call(reader, get, { id: 500 });
      expect(malformed.error).toBe(true);
      expect(JSON.stringify(malformed)).not.toContain('PRIVATE');
      const count = requests.length;
      for (const [name, args] of [
        [get, { id: 'invalid' }],
        [list, { company: 'other' }],
        [list, { filter: 'unknown' }],
        ['flexi_get_record', { evidence: 'mzdy', id: 1 }],
        [create, input],
      ] as const) {
        expect((await call(reader, name, args)).error).toBe(true);
      }
      expect(requests).toHaveLength(count);
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 20000);
