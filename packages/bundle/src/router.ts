import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from 'node:http';
import { Transform } from 'node:stream';
import {
  authenticate,
  HttpFailure,
  type RuntimeConfig,
  resolveCredential,
  safeFailure,
  singleHeader,
} from '@dxheroes/mcp-runtime';
import type { BundleManifest, Service } from './config.js';
import { serveStdioRequest } from './stdio.js';
import { Supervisor } from './supervisor.js';

function headers(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...input };
  for (const key of [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...(input.connection ?? '').split(',').map((s) => s.trim().toLowerCase()),
  ])
    delete result[key];
  return result;
}
async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  service: Service,
  credential: string | undefined,
): Promise<void> {
  const outgoing = headers(req.headers);
  for (const key of Object.keys(outgoing))
    if (
      key === 'authorization' ||
      key === 'cookie' ||
      key === 'forwarded' ||
      key.startsWith('x-forwarded-') ||
      key.startsWith('x-mcp-')
    )
      delete outgoing[key];
  outgoing.host = `127.0.0.1:${service.port}`;
  outgoing.origin = 'http://127.0.0.1';
  if (service.childToken) outgoing.authorization = `Bearer ${service.childToken}`;
  if (credential !== undefined)
    outgoing['x-mcp-upstream-credential'] = Buffer.from(credential).toString('base64url');
  outgoing['x-mcp-credential-mode'] = singleHeader(req, 'x-mcp-credential-mode') ?? 'shared';
  await new Promise<void>((resolve, reject) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: service.port,
        path: '/mcp',
        method: req.method,
        headers: outgoing,
      },
      (response) => {
        // Never follow redirects or expose a private child location to a caller.
        if (response.statusCode! >= 300 && response.statusCode! < 400) {
          response.resume();
          safeFailure(res, 502, 'child_redirect_refused');
          return;
        }
        res.writeHead(response.statusCode!, headers(response.headers));
        res.flushHeaders();
        response.on('error', () => res.destroy());
        response.pipe(res);
      },
    );
    const abort = () => upstream.destroy();
    res.once('close', abort);
    res.once('close', resolve);
    upstream.once('error', reject);
    let size = 0;
    const bounded = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > 2 * 1024 * 1024 ? new HttpFailure(413, 'body_too_large') : null, chunk);
      },
    });
    bounded.on('error', (error) => {
      upstream.destroy();
      reject(error);
    });
    req.on('aborted', abort);
    req.pipe(bounded).pipe(upstream);
  });
}
export function createBundle(
  manifest: BundleManifest,
  config: RuntimeConfig & { catalogAccessToken: string },
) {
  if (
    !config.accessToken ||
    !config.catalogAccessToken ||
    config.accessToken === config.catalogAccessToken
  )
    throw new Error('distinct_bundle_tokens_required');
  const supervisor = new Supervisor(manifest.services);
  const active = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  let stopping = false;
  const server = createServer({ maxHeaderSize: 65536, requestTimeout: 30000 }, (req, res) => {
    const task = (async () => {
      let id: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        authenticate(
          req,
          req.url === '/catalog/v1/servers'
            ? { ...config, accessToken: config.catalogAccessToken }
            : config,
        );
        if (stopping) throw new HttpFailure(503, 'stopping');
        if (req.url === '/health' && req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              status: 'running',
              services: Object.fromEntries(supervisor.states),
              active: Object.fromEntries(active),
            }),
          );
          return;
        }
        if (req.url === '/catalog/v1/servers' && req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(manifest.catalog));
          return;
        }
        const service = manifest.services.find((s) => req.url === `/mcp/${s.id}`);
        if (!service) throw new HttpFailure(404, 'not_found');
        if (!['POST', 'GET', 'DELETE'].includes(req.method ?? ''))
          throw new HttpFailure(405, 'method_not_allowed');
        const mode = singleHeader(req, 'x-mcp-credential-mode') ?? 'shared';
        if (mode !== 'shared' && mode !== 'per_user')
          throw new HttpFailure(400, 'invalid_credential_mode');
        if (
          !service.credentialModes.includes(mode) ||
          (singleHeader(req, 'x-mcp-upstream-credential') && !service.credentialChannel)
        )
          throw new HttpFailure(400, 'credential_mode_unsupported');
        const credential = resolveCredential(req, {
          sharedCredential: mode === 'shared' ? service.sharedCredential : undefined,
        })?.apiKey;
        if (pending.size >= 64 || (active.get(service.id) ?? 0) >= service.maxActive)
          throw new HttpFailure(503, 'capacity_reached');
        if (service.transport === 'http' && supervisor.states.get(service.id)?.status !== 'ready')
          throw new HttpFailure(503, 'service_unavailable');
        id = service.id;
        active.set(id, (active.get(id) ?? 0) + 1);
        timer = setTimeout(() => res.destroy(), config.totalTimeoutMs);
        res.setTimeout(config.idleTimeoutMs, () => res.destroy());
        if (service.transport === 'http') await forward(req, res, service, credential);
        else await serveStdioRequest(req, res, service, credential);
      } catch (error) {
        safeFailure(
          res,
          error instanceof HttpFailure ? error.status : 502,
          error instanceof HttpFailure ? error.code : 'service_failed',
        );
      } finally {
        if (timer) clearTimeout(timer);
        if (id) active.set(id, active.get(id)! - 1);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  return {
    server,
    supervisor,
    active,
    start: () => supervisor.start(),
    async close() {
      stopping = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(pending);
      await supervisor.close();
    },
  };
}
