import {
  type McpPackage,
  type McpServer,
  normalizeToolInputSchemas,
  normalizeToolResult,
  withToolCallContext,
} from '@dxheroes/mcp-kit';
import type {
  CallToolResult,
  GetPromptResult,
  ListToolsResult,
  ReadResourceResult,
} from '@modelcontextprotocol/server';
import { Server } from '@modelcontextprotocol/server';
import { requestBudget } from './lifecycle.js';

export function createAdapter(
  pkg: McpPackage,
  connector: McpServer,
  limits = { totalTimeoutMs: 3600000, idleTimeoutMs: 300000 },
): Server & { drainOperations: () => Promise<void> } {
  const server = new Server(
    { name: pkg.metadata.id, version: pkg.metadata.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const operations = new Set<Promise<unknown>>();
  async function track<T>(run: () => Promise<T>): Promise<T> {
    const operation = run();
    operations.add(operation);
    try {
      return await operation;
    } finally {
      operations.delete(operation);
    }
  }
  async function bounded<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const budget = requestBudget(signal, limits.totalTimeoutMs, limits.idleTimeoutMs);
    try {
      const result = await track(() => withToolCallContext({ signal: budget.signal }, run));
      budget.signal.throwIfAborted();
      return result;
    } finally {
      budget.dispose();
    }
  }
  server.setRequestHandler(
    'tools/list',
    async () =>
      ({ tools: normalizeToolInputSchemas(await connector.listTools()) }) as ListToolsResult,
  );
  server.setRequestHandler('tools/call', async (request, context) =>
    track(async () => {
      const budget = requestBudget(
        context.mcpReq.signal,
        limits.totalTimeoutMs,
        limits.idleTimeoutMs,
      );
      let progress = 0;
      try {
        const result = await withToolCallContext({ signal: budget.signal }, () =>
          connector.callTool(request.params.name, request.params.arguments ?? {}, {
            signal: budget.signal,
            onProgress: async () => {
              budget.progress();
              const token = request.params._meta?.progressToken;
              if (token !== undefined)
                await context.mcpReq.notify({
                  method: 'notifications/progress',
                  params: { progressToken: token, progress: ++progress },
                });
            },
          }),
        );
        budget.signal.throwIfAborted();
        const tool = (await connector.listTools()).find((t) => t.name === request.params.name);
        return server.projectCallToolResult(
          normalizeToolResult(result).result as CallToolResult,
          tool?.outputSchema,
        );
      } finally {
        budget.dispose();
      }
    }),
  );
  server.setRequestHandler('resources/list', async () => ({
    resources: await connector.listResources(),
  }));
  server.setRequestHandler('resources/read', async (req, context) =>
    bounded(
      context.mcpReq.signal,
      async () => (await connector.readResource(req.params.uri)) as ReadResourceResult,
    ),
  );
  server.setRequestHandler('prompts/list', async () => ({
    prompts: await connector.listPrompts(),
  }));
  server.setRequestHandler('prompts/get', async (req, context) =>
    bounded(
      context.mcpReq.signal,
      async () =>
        (await connector.getPrompt(req.params.name, req.params.arguments)) as GetPromptResult,
    ),
  );
  return Object.assign(server, {
    drainOperations: async () => {
      await Promise.allSettled(operations);
    },
  });
}
