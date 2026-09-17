import { Console } from 'node:console';
import type { McpPackage } from '@dxheroes/mcp-kit';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createAdapter } from './adapter.js';
import { loadConfig, readSecret } from './config.js';
import { createConnectorHttpServer } from './http.js';

export async function runConnectorCli(
  pkg: McpPackage,
  args = process.argv.slice(2),
): Promise<void> {
  // Connector diagnostics must never share stdout with JSON-RPC.
  globalThis.console = new Console(process.stderr, process.stderr);
  try {
    if (args.length !== 1 || !['--stdio', '--http'].includes(args[0]!))
      throw new Error('Usage: --stdio | --http');
    let close: () => Promise<void>;
    if (args[0] === '--stdio') {
      const secret = await readSecret(process.env, 'MCP_UPSTREAM_CREDENTIAL');
      const adapters = new Set<ReturnType<typeof createAdapter>>();
      const connectors = new Set<ReturnType<McpPackage['createServer']>>();
      const handle = serveStdio(async () => {
        const connector = pkg.createServer(
          secret ? { apiKey: secret, headerName: 'Authorization', headerValue: secret } : null,
        );
        connectors.add(connector);
        await connector.initialize();
        const adapter = createAdapter(pkg, connector);
        adapters.add(adapter);
        return adapter;
      });
      close = async () => {
        await handle.close();
        await Promise.all([...adapters].map((a) => a.drainOperations()));
        await Promise.all([...connectors].map((c) => c.close()));
      };
      process.stdin.once('end', () => {
        void close();
      });
    } else {
      const config = await loadConfig();
      const runtime = createConnectorHttpServer(pkg, config);
      await new Promise<void>((resolve, reject) => {
        runtime.server.once('error', reject);
        runtime.server.listen(config.port, config.host, resolve);
      });
      close = runtime.close;
    }
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        const deadline = setTimeout(() => process.exit(1), 10000);
        void close().then(() => {
          clearTimeout(deadline);
          process.exitCode = 0;
        });
      });
  } catch {
    console.error('MCP runtime startup failed; check explicit runtime configuration');
    process.exitCode = 1;
  }
}
