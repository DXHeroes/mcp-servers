import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../packages/runtime/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/client'))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio'))
);
const [id, port, image, secret = ''] = process.argv.slice(2);
const counts = {
  'abra-flexi': 30,
  byzdata: 9,
  fakturoid: 45,
  'gemini-deep-research': 2,
  merk: 23,
  postgres: 2,
  toggl: 37,
};
const receipt = { id, eras: [] };
for (const era of process.env.MCP_SMOKE_STDIO_ONLY ? [] : ['legacy', 'auto']) {
  const client = new Client(
    { name: 'image-smoke', version: '1.0.0' },
    era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://${process.env.MCP_SMOKE_HOST ?? '127.0.0.1'}:${port}/mcp`),
        {
          requestInit: { headers: { Authorization: 'Bearer synthetic-service-token' } },
        },
      ),
    );
    assert.equal((await client.listTools()).tools.length, counts[id]);
    assert.equal(
      (await client.callTool({ name: '__synthetic_unknown_tool__', arguments: {} })).isError,
      true,
    );
    if (id === 'toggl') {
      const result = await client.callTool({ name: 'toggl_me', arguments: {} });
      assert(!result.isError, JSON.stringify(result));
      assert.match(result.content[0].text, /Synthetic TLS identity/);
    }
    if (id === 'postgres') {
      const result = await client.callTool({
        name: 'postgres_query',
        arguments: { sql: 'SELECT 42 AS synthetic_answer' },
      });
      assert(!result.isError, JSON.stringify(result));
      assert.match(result.content[0].text, /42/);
    }
    receipt.eras.push(client.getNegotiatedProtocolVersion());
  } finally {
    await client.close();
  }
}
if (!process.env.MCP_SMOKE_HTTP_ONLY) {
  const stdio = new Client({ name: 'image-stdio', version: '1.0.0' });
  try {
    await stdio.connect(
      new StdioClientTransport({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network',
          'none',
          '--read-only',
          '--user',
          '12345:12345',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          ...(secret ? ['-e', `MCP_UPSTREAM_CREDENTIAL=${secret}`] : []),
          image,
          '--stdio',
        ],
        stderr: 'pipe',
      }),
    );
    assert.equal((await stdio.listTools()).tools.length, counts[id]);
    assert.equal(
      (await stdio.callTool({ name: '__synthetic_unknown_tool__', arguments: {} })).isError,
      true,
    );
    receipt.stdio = true;
  } finally {
    await stdio.close();
  }
}
console.log(JSON.stringify(receipt));
