import { setMaxListeners } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { McpPackage } from '@dxheroes/mcp-kit';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createAdapter } from './adapter.js';
import { authenticate, HttpFailure, resolveCredential } from './auth.js';
import type { RuntimeConfig } from './config.js';

export function safeFailure(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
  });
  res.end(JSON.stringify({ error: code }));
}
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw new HttpFailure(415, 'json_required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new HttpFailure(413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpFailure(400, 'invalid_json');
  }
}
export function createConnectorHttpServer(pkg: McpPackage, config: RuntimeConfig) {
  const pending = new Set<Promise<void>>();
  const shutdown = new AbortController();
  setMaxListeners(256, shutdown.signal);
  const server = createServer({ maxHeaderSize: 65536, requestTimeout: 30000 }, (req, res) => {
    const task = (async () => {
      let dispose: (() => Promise<void>) | undefined;
      let drain: (() => Promise<void>) | undefined;
      let handler: ReturnType<typeof createMcpHandler> | undefined;
      const timeout = setTimeout(() => res.destroy(), config.totalTimeoutMs);
      const cancel = () => res.destroy();
      shutdown.signal.addEventListener('abort', cancel, { once: true });
      try {
        if (req.url === '/health' && req.method === 'GET') {
          res.end('{"status":"ready"}');
          return;
        }
        if (req.url !== '/mcp') throw new HttpFailure(404, 'not_found');
        authenticate(req, config);
        if (pending.size >= 128) throw new HttpFailure(503, 'capacity_reached');
        const credential = resolveCredential(req, config);
        if (req.method !== 'POST') throw new HttpFailure(405, 'method_not_allowed');
        const body = await readBody(req, config.maxBodyBytes);
        handler = createMcpHandler(
          async () => {
            const connector = pkg.createServer(credential);
            let closed = false;
            dispose = async () => {
              if (!closed) {
                closed = true;
                await connector.close();
              }
            };
            await connector.initialize();
            const adapter = createAdapter(pkg, connector, config);
            drain = adapter.drainOperations;
            return adapter;
          },
          { legacy: 'stateless', responseMode: 'auto' },
        );
        await toNodeHandler(handler)(req, res, body);
      } catch (error) {
        safeFailure(
          res,
          error instanceof HttpFailure ? error.status : 500,
          error instanceof HttpFailure ? error.code : 'request_failed',
        );
      } finally {
        clearTimeout(timeout);
        shutdown.signal.removeEventListener('abort', cancel);
        try {
          await handler?.close();
        } finally {
          try {
            await drain?.();
          } finally {
            await dispose?.();
          }
        }
      }
    })();
    pending.add(task);
    void task
      .finally(() => pending.delete(task))
      .catch(() => {
        /* no secret-bearing diagnostics */
      });
  });
  return {
    server,
    async close() {
      shutdown.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.allSettled(pending);
    },
  };
}
