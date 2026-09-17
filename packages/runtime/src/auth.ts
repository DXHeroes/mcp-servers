import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ApiKeyConfig } from '@dxheroes/mcp-kit';
import type { RuntimeConfig } from './config.js';

export class HttpFailure extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1]!);
  }
  if (values.length > 1) throw new HttpFailure(400, 'invalid_headers');
  return values[0];
}
export function authenticate(
  req: IncomingMessage,
  config: Pick<RuntimeConfig, 'accessToken' | 'allowedHosts' | 'allowedOrigins'>,
): void {
  const host = singleHeader(req, 'host');
  if (!host || /[\s/@?#\\]/.test(host)) throw new HttpFailure(403, 'host_refused');
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    throw new HttpFailure(403, 'host_refused');
  }
  if (!host || !config.allowedHosts.includes(hostname!)) throw new HttpFailure(403, 'host_refused');
  const origin = singleHeader(req, 'origin');
  if (origin && !config.allowedOrigins.includes(origin))
    throw new HttpFailure(403, 'origin_refused');
  const authorization = singleHeader(req, 'authorization');
  if (config.accessToken) {
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (
      !authorization ||
      !timingSafeEqual(digest(authorization), digest(`Bearer ${config.accessToken}`))
    )
      throw new HttpFailure(401, 'unauthorized');
  }
}
export function resolveCredential(
  req: IncomingMessage,
  config: Pick<RuntimeConfig, 'sharedCredential'>,
): ApiKeyConfig | null {
  const mode = singleHeader(req, 'x-mcp-credential-mode') ?? 'shared';
  if (mode !== 'shared' && mode !== 'per_user')
    throw new HttpFailure(400, 'invalid_credential_mode');
  const encoded = singleHeader(req, 'x-mcp-upstream-credential');
  let secret: string | undefined;
  if (encoded !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 45000) throw new Error();
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw new Error();
      secret = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!secret || secret.includes('\0')) throw new Error();
    } catch {
      throw new HttpFailure(400, 'invalid_upstream_credential');
    }
  }
  if (mode === 'per_user' && secret === undefined)
    throw new HttpFailure(400, 'upstream_credential_required');
  secret ??= config.sharedCredential;
  return secret === undefined
    ? null
    : { apiKey: secret, headerName: 'Authorization', headerValue: secret };
}
