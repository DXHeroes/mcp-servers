import { createServer } from 'node:http';
import { authenticate, HttpFailure, type RuntimeConfig, safeFailure } from '@dxheroes/mcp-runtime';
import { ManifestStore } from './manifest.js';

export function createCatalogServer(
  path: string,
  config: Pick<RuntimeConfig, 'accessToken' | 'allowedHosts' | 'allowedOrigins'>,
) {
  const store = new ManifestStore(path);
  let reload: Promise<void> | undefined;
  return createServer({ requestTimeout: 10000, maxHeaderSize: 16384 }, (req, res) => {
    void (async () => {
      try {
        if (req.method !== 'GET') throw new HttpFailure(405, 'method_not_allowed');
        if (req.url !== '/health' && req.url !== '/catalog/v1/servers')
          throw new HttpFailure(404, 'not_found');
        if (req.url !== '/health') authenticate(req, config);
        reload ??= store.reload().finally(() => {
          reload = undefined;
        });
        await reload;
        res.writeHead(store.ready ? 200 : 503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(
          JSON.stringify(
            req.url === '/health'
              ? { status: store.ready ? 'ready' : 'invalid_manifest' }
              : (store.current ?? { error: 'manifest_unavailable' }),
          ),
        );
      } catch (error) {
        safeFailure(
          res,
          error instanceof HttpFailure ? error.status : 500,
          error instanceof HttpFailure ? error.code : 'catalog_failed',
        );
      }
    })();
  });
}
