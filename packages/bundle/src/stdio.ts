import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpFailure } from '@dxheroes/mcp-runtime';
import {
  Client,
  type JSONRPCMessage,
  parseJSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { processEnvironment, type Service } from './config.js';
import { launch, reap } from './process.js';

/** Exact environment and process-group ownership; no inherited SDK default env. */
class ProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private closing?: Promise<void>;
  private failure?: Error;
  constructor(
    private service: Service,
    private credential?: string,
  ) {}
  async start(): Promise<void> {
    const child = launch(this.service, processEnvironment(this.service, this.credential), true);
    this.child = child;
    // Node emits stream errors in addition to invoking write callbacks. Keep
    // listeners installed through teardown so either order is handled safely.
    child.stdin!.on('error', () => this.fail('stdio_pipe_failed'));
    child.stdout!.on('error', () => this.fail('stdio_pipe_failed'));
    let buffer = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (this.failure || this.closing) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
        this.fail('stdio_message_limit');
        return;
      }
      let end = buffer.indexOf('\n');
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf('\n');
        try {
          this.onmessage?.(parseJSONRPCMessage(JSON.parse(line)));
        } catch {
          this.fail('invalid_stdio_message');
          return;
        }
      }
    });
    child.on('error', () => this.fail('stdio_process_failed'));
    child.on('close', () => this.onclose?.());
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(this.fail('stdio_process_failed')));
    });
  }
  private fail(code: string): Error {
    if (!this.failure) {
      this.failure = new Error(code);
      void this.close();
      this.onerror?.(this.failure);
    }
    return this.failure;
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closing || !this.child?.stdin) throw new Error('stdio_transport_closed');
    const input = this.child.stdin;
    await new Promise<void>((resolve, reject) => {
      try {
        input.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) reject(this.fail('stdio_pipe_failed'));
          else resolve();
        });
      } catch {
        reject(this.fail('stdio_pipe_failed'));
      }
    });
  }
  close(): Promise<void> {
    this.closing ??= this.child ? reap(this.child) : Promise.resolve();
    return this.closing;
  }
}
export async function serveStdioRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: Service,
  credential?: string,
): Promise<void> {
  let transport: ProcessTransport | undefined;
  let client: Client | undefined;
  const cancel = () => {
    void transport?.close();
  };
  res.once('close', cancel);
  const handler = createMcpHandler(
    async () => {
      const server = new Server(
        { name: `bundle-${service.id}`, version: '0.1.0' },
        { capabilities: { tools: {}, resources: {}, prompts: {} } },
      );
      const connect = async () => {
        if (res.destroyed) throw new Error('request_closed');
        if (!client) {
          transport = new ProcessTransport(service, credential);
          client = new Client({ name: 'bundle-stdio', version: '0.1.0' });
          await client.connect(transport, { timeout: 10000 });
        }
        return client;
      };
      server.setRequestHandler('tools/list', async (request) =>
        (await connect()).listTools(request.params),
      );
      server.setRequestHandler('tools/call', async (request, context) =>
        (await connect()).callTool(request.params, {
          signal: context.mcpReq.signal,
          timeout: 3600000,
          onprogress: async (progress) => {
            const token = request.params._meta?.progressToken;
            if (token !== undefined)
              await context.mcpReq.notify({
                method: 'notifications/progress',
                params: { ...progress, progressToken: token },
              });
          },
        }),
      );
      server.setRequestHandler('resources/list', async (request) =>
        (await connect()).listResources(request.params),
      );
      server.setRequestHandler('resources/read', async (request) =>
        (await connect()).readResource(request.params),
      );
      server.setRequestHandler('prompts/list', async (request) =>
        (await connect()).listPrompts(request.params),
      );
      server.setRequestHandler('prompts/get', async (request) =>
        (await connect()).getPrompt(request.params),
      );
      return server;
    },
    { legacy: 'stateless', responseMode: 'auto' },
  );
  try {
    let body: unknown;
    if (req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
        throw new HttpFailure(415, 'json_required');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new HttpFailure(413, 'body_too_large');
        chunks.push(Buffer.from(chunk));
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new HttpFailure(400, 'invalid_json');
      }
    }
    await toNodeHandler(handler)(req, res, body);
  } finally {
    res.off('close', cancel);
    await handler.close();
    await client?.close();
    await transport?.close();
  }
}
