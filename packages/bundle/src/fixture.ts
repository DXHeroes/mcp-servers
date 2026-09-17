import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

function factory(context: { requestInfo?: Request }) {
  const encoded = context.requestInfo?.headers.get('x-mcp-upstream-credential');
  const credential = encoded
    ? Buffer.from(encoded, 'base64url').toString()
    : (process.env.MCP_UPSTREAM_CREDENTIAL ?? 'none');
  const server = new Server(
    { name: 'typescript-fixture', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [
      {
        name: 'context_echo',
        description: 'Synthetic context digest',
        inputSchema: { type: 'object', properties: { wait: { type: 'number' } } },
      },
    ],
  }));
  server.setRequestHandler('tools/call', async (request, context) => {
    const wait = Number(request.params.arguments?.wait ?? 0);
    for (let n = 0; n < wait; n++) {
      await delay(25, undefined, { signal: context.mcpReq.signal });
      const token = request.params._meta?.progressToken;
      if (token !== undefined)
        await context.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken: token, progress: n, total: wait },
        });
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            digest: createHash('sha256').update(credential).digest('hex'),
            pid: process.pid,
            forbiddenEnv: ['EDGE_SECRET', 'OTHER_SECRET', 'MCP_BUNDLE_MANIFEST'].some(
              (k) => k in process.env,
            ),
          }),
        },
      ],
    };
  });
  server.setRequestHandler('resources/list', () => ({
    resources: [{ uri: 'fixture://status', name: 'Status' }],
  }));
  server.setRequestHandler('resources/read', () => ({
    contents: [{ uri: 'fixture://status', text: 'ready' }],
  }));
  server.setRequestHandler('prompts/list', () => ({ prompts: [{ name: 'greet' }] }));
  server.setRequestHandler('prompts/get', () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
  }));
  return server;
}
if (process.argv.includes('--stdio')) {
  const handle = serveStdio(factory);
  process.once('SIGTERM', () => {
    void handle.close();
  });
} else {
  const handler = createMcpHandler(factory, { legacy: 'stateless', responseMode: 'auto' });
  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.end('ready');
      return;
    }
    if (
      req.headers.host !== `127.0.0.1:${process.env.MCP_PORT}` ||
      (req.headers.origin && req.headers.origin !== 'http://127.0.0.1')
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    void toNodeHandler(handler)(req, res);
  });
  http.listen(Number(process.env.MCP_PORT), '127.0.0.1');
  process.once('SIGTERM', () => {
    http.closeAllConnections();
    http.close();
    void handler.close();
  });
}
