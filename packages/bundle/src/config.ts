import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { type Manifest, parseManifest } from '@dxheroes/mcp-catalog';

export interface Service {
  id: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  transport: 'http' | 'stdio';
  port?: number;
  childToken?: string;
  sharedCredential?: string;
  credentialModes: readonly ('shared' | 'per_user')[];
  credentialChannel: boolean;
  maxActive: number;
}
export interface BundleManifest {
  catalog: Manifest;
  services: Service[];
}
const fail = (): never => {
  throw new Error('invalid_bundle_configuration');
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const str = (v: unknown): string =>
  typeof v === 'string' && v.length > 0 && !v.includes('\0') ? v : fail();
export async function parseBundle(
  source: string,
  edgeToken: string,
  env = process.env,
  catalogToken?: string,
): Promise<BundleManifest> {
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) fail();
  const root = object(JSON.parse(source));
  const catalog = parseManifest(JSON.stringify(root.catalog));
  if (
    !Array.isArray(root.services) ||
    root.services.length > 16 ||
    root.services.length !== catalog.servers.length
  )
    fail();
  const used = new Set<string>();
  const ports = new Set<number>();
  const secret = async (v: unknown): Promise<string | undefined> => {
    if (v === undefined) return undefined;
    const ref = object(v);
    if (Object.keys(ref).length !== 1) fail();
    const value = ref.env
      ? env[str(ref.env)]
      : ref.file
        ? (await readFile(str(ref.file), 'utf8')).replace(/\r?\n$/, '')
        : fail();
    if (
      !value ||
      value === edgeToken ||
      value === catalogToken ||
      value.includes('\0') ||
      Buffer.byteLength(value) > 32768
    )
      fail();
    return value;
  };
  const services: Service[] = [];
  for (const raw of root.services as unknown[]) {
    const item = object(raw);
    const id = str(item.id);
    const offer = catalog.servers.find((s) => s.id === id);
    if (!offer || used.has(id) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) fail();
    used.add(id);
    if (new URL(offer!.endpoint.url).pathname !== `/mcp/${id}`) fail();
    const auth = offer!.auth;
    const credentialChannel =
      auth.type === 'api_key' && auth.credentialDelivery === 'connector_base64url';
    if (
      !(auth.type === 'none' || credentialChannel) ||
      auth.oauthDefaults ||
      (auth.type === 'none' && auth.credentialModes.some((m) => m !== 'shared'))
    )
      fail();
    if (!Array.isArray(item.argv) || !item.argv.length || item.argv.length > 64) fail();
    const argv = (item.argv as unknown[]).map(str);
    const cwd = str(item.cwd);
    if (!isAbsolute(argv[0]!) || !isAbsolute(cwd)) fail();
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(object(item.env ?? {}))) {
      if (
        !/^[A-Z][A-Z0-9_]*$/.test(key) ||
        /^(?:NODE_OPTIONS|PYTHONPATH|PYTHONHOME|LD_.*|DYLD_.*|MCP_ACCESS_TOKEN.*|MCP_UPSTREAM_CREDENTIAL.*)$/.test(
          key,
        )
      )
        fail();
      childEnv[key] = str(value);
    }
    const credentialModes = auth.credentialModes.map((mode) => {
      if (mode === 'shared' || mode === 'per_user') return mode;
      return fail();
    });
    if (credentialModes.includes('per_user') && item.requestCredentials !== 'connector_base64url')
      fail();
    if (item.transport !== 'http' && item.transport !== 'stdio') fail();
    const transport = item.transport as 'http' | 'stdio';
    const port = item.port as number | undefined;
    if (transport === 'http') {
      if (!Number.isInteger(port) || port! < 1024 || port! > 65535 || ports.has(port!)) fail();
      ports.add(port!);
    } else if (port !== undefined) fail();
    const childToken = await secret(item.childToken);
    const sharedCredential = await secret(item.sharedCredential);
    if (childToken && childToken === sharedCredential) fail();
    const maxActive = item.maxActive ?? 8;
    if (!Number.isInteger(maxActive) || Number(maxActive) < 1 || Number(maxActive) > 32) fail();
    services.push({
      id,
      argv,
      cwd,
      env: childEnv,
      transport,
      port,
      childToken,
      sharedCredential,
      credentialModes,
      credentialChannel,
      maxActive: Number(maxActive),
    });
  }
  return { catalog, services };
}
export function processEnvironment(service: Service, credential?: string): Record<string, string> {
  return {
    ...service.env,
    ...(service.transport === 'http'
      ? {
          MCP_HOST: '127.0.0.1',
          MCP_PORT: String(service.port),
          MCP_ALLOWED_HOSTS: '127.0.0.1',
          MCP_ALLOWED_ORIGINS: 'http://127.0.0.1',
        }
      : {}),
    ...(service.childToken ? { MCP_ACCESS_TOKEN: service.childToken } : {}),
    ...(credential !== undefined ? { MCP_UPSTREAM_CREDENTIAL: credential } : {}),
  };
}
