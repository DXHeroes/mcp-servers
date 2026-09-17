// Genuine legacy MCP, deliberately without an MCP server SDK. REST APIs belong
// behind the gateway's OpenAPI adapter, not this protocol route.

import { createHash, randomUUID } from 'node:crypto';
import express from '@dxheroes/mcp-bundle/express';

const app = express();
app.use(express.json({ limit: '2mb' }));
const sessions = new Map();
app.get('/health', (_req, res) => res.send('ready'));
app.use('/mcp', (req, res, next) => {
  if (
    req.headers.host !== `127.0.0.1:${process.env.MCP_PORT}` ||
    (req.headers.origin && req.headers.origin !== 'http://127.0.0.1')
  )
    return res.sendStatus(403);
  next();
});
app.post('/mcp', (req, res) => {
  const { id, method, params } = req.body ?? {};
  if (method === 'server/discover')
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Legacy MCP' } });
  if (method === 'initialize') {
    if (sessions.size >= 64) return res.sendStatus(503);
    const session = randomUUID();
    sessions.set(session, { streams: new Set(), calls: new Map() });
    res.set('Mcp-Session-Id', session);
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'express-fixture', version: '0.1.0' },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      },
    });
  }
  const session = sessions.get(req.headers['mcp-session-id']);
  if (!session) return res.sendStatus(404);
  if (method === 'notifications/cancelled') {
    session.calls.get(params?.requestId)?.();
    return res.sendStatus(202);
  }
  if (id === undefined) return res.sendStatus(202);
  let result;
  if (method === 'tools/list')
    result = {
      tools: [
        {
          name: 'context_echo',
          description: 'Synthetic context digest',
          inputSchema: { type: 'object', properties: { wait: { type: 'number' } } },
        },
      ],
    };
  else if (method === 'resources/list')
    result = { resources: [{ uri: 'fixture://status', name: 'Status' }] };
  else if (method === 'resources/read')
    result = { contents: [{ uri: 'fixture://status', text: 'ready' }] };
  else if (method === 'prompts/list') result = { prompts: [{ name: 'greet' }] };
  else if (method === 'prompts/get')
    result = { messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }] };
  else if (method === 'tools/call') {
    const encoded = req.headers['x-mcp-upstream-credential'];
    const secret = encoded ? Buffer.from(encoded, 'base64url').toString() : 'none';
    result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            digest: createHash('sha256').update(secret).digest('hex'),
            pid: process.pid,
          }),
        },
      ],
    };
    if (params?.arguments?.wait) {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.flushHeaders();
      let progress = 0;
      const stop = () => {
        clearInterval(timer);
        session.calls.delete(id);
        res.end();
      };
      const timer = setInterval(() => {
        const progressToken = params._meta?.progressToken;
        if (progressToken !== undefined)
          res.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: progress++, total: params.arguments.wait } })}\n\n`,
          );
        else progress++;
        if (progress >= params.arguments.wait) {
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
          stop();
        }
      }, 25);
      session.calls.set(id, stop);
      res.once('close', stop);
      return;
    }
  } else
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } });
  res.json({ jsonrpc: '2.0', id, result });
});
app.get('/mcp', (req, res) => {
  const session = sessions.get(req.headers['mcp-session-id']);
  if (!session) return res.sendStatus(404);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  session.streams.add(res);
  res.once('close', () => session.streams.delete(res));
});
app.delete('/mcp', (req, res) => {
  const id = req.headers['mcp-session-id'];
  const session = sessions.get(id);
  if (!session) return res.sendStatus(404);
  for (const stop of session.calls.values()) stop();
  for (const stream of session.streams) stream.end();
  sessions.delete(id);
  res.sendStatus(200);
});
const server = app.listen(Number(process.env.MCP_PORT), '127.0.0.1');
process.once('SIGTERM', () => {
  server.closeAllConnections();
  server.close();
});
