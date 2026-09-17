import { readFile } from 'node:fs/promises';

export interface RuntimeConfig {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  accessToken?: string;
  sharedCredential?: string;
  localTestMode: boolean;
  maxBodyBytes: number;
  totalTimeoutMs: number;
  idleTimeoutMs: number;
}

export async function readSecret(
  env: NodeJS.ProcessEnv,
  name: string,
): Promise<string | undefined> {
  if (env[name] !== undefined && env[`${name}_FILE`] !== undefined) {
    throw new Error(`Configure only one ${name} source`);
  }
  const value = env[`${name}_FILE`]
    ? (await readFile(env[`${name}_FILE`]!, 'utf8')).replace(/\r?\n$/, '')
    : env[name];
  if (value !== undefined && (value.length === 0 || Buffer.byteLength(value) > 32768)) {
    throw new Error(`Invalid ${name} configuration`);
  }
  return value;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeConfig> {
  const localTestMode = env.MCP_LOCAL_TEST_MODE === 'true';
  const host = env.MCP_HOST ?? '0.0.0.0';
  if (localTestMode && !['127.0.0.1', '::1'].includes(host)) {
    throw new Error('Local test mode requires a loopback listener');
  }
  const accessToken = await readSecret(env, 'MCP_ACCESS_TOKEN');
  if (!accessToken && !localTestMode) throw new Error('MCP_ACCESS_TOKEN is required');
  const allowedHosts = (env.MCP_ALLOWED_HOSTS ?? (localTestMode ? '127.0.0.1,localhost,[::1]' : ''))
    .split(',')
    .filter(Boolean);
  if (allowedHosts.length === 0 || allowedHosts.includes('*'))
    throw new Error('Explicit MCP_ALLOWED_HOSTS required');
  const port = Number(env.MCP_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP_PORT');
  return {
    host,
    port,
    allowedHosts,
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
    accessToken,
    sharedCredential: await readSecret(env, 'MCP_UPSTREAM_CREDENTIAL'),
    localTestMode,
    maxBodyBytes: 2 * 1024 * 1024,
    totalTimeoutMs: 60 * 60 * 1000,
    idleTimeoutMs: 5 * 60 * 1000,
  };
}
