/**
 * Transport helpers for `FakturoidClient` — credential parsing, URL building,
 * error-body reading, and the OAuth client-credentials token exchange.
 *
 * These are free functions rather than methods so the client itself stays a
 * list of API calls; none of them holds state (the token cache lives on the
 * client).
 */

import { safeFetch } from '@dxheroes/mcp-kit';
import { FakturoidApiError } from './client-errors.js';

export interface FakturoidCredentials {
  slug: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Split the configured `"slug:client_id:client_secret"` triple.
 *
 * The secret may itself contain colons, so everything past the second
 * separator is the secret.
 */
export function parseApiKey(apiKey: string): FakturoidCredentials {
  const parts = apiKey.split(':');
  if (parts.length < 3) {
    throw new Error(
      'Invalid API key format. Expected "slug:client_id:client_secret". ' +
        'Get your OAuth credentials at Settings > User Account in your Fakturoid account.',
    );
  }
  const slug = parts[0];
  const clientId = parts[1];
  const clientSecret = parts.slice(2).join(':');

  if (!slug || !clientId || !clientSecret) {
    throw new Error(
      'Invalid API key format. Slug, client_id, and client_secret are all required. ' +
        'Format: "your-account-slug:your-client-id:your-client-secret"',
    );
  }

  return { slug, clientId, clientSecret };
}

export function buildAccountUrl(
  baseUrl: string,
  slug: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  const url = `${baseUrl}/accounts/${slug}/${path}`;
  if (!params) return url;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `${url}?${qs}` : url;
}

/** The upstream error text, falling back to the status line when there is none. */
export async function readErrorMessage(response: Response): Promise<string> {
  try {
    const errorBody = await response.text();
    return errorBody || response.statusText;
  } catch {
    return response.statusText;
  }
}

export interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
}

/** One OAuth client-credentials exchange. Caching is the caller's job. */
export async function requestAccessToken(config: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  userAgent: string;
}): Promise<AccessTokenResponse> {
  const tokenUrl = `${config.baseUrl}/oauth/token`;
  const credentials = btoa(`${config.clientId}:${config.clientSecret}`);

  // `safeFetch` rather than bare `fetch` for consistency with what the
  // host enforces on remote MCP servers. `allowPrivate: true` matches the
  // host default (`MCP_ALLOW_PRIVATE_NETWORK_TARGETS`), so a self-hosted
  // Fakturoid-compatible endpoint on an internal network keeps working;
  // link-local and the cloud metadata endpoint stay blocked either way.
  const response = await safeFetch(tokenUrl, {
    method: 'POST',
    allowPrivate: true,
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.userAgent,
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new FakturoidApiError(
      `OAuth token exchange failed: ${await readErrorMessage(response)}`,
      response.status,
      'TOKEN_EXCHANGE_FAILED',
      'Check the client_id and client_secret in the configured API key ' +
        '("slug:client_id:client_secret"). Fakturoid issues them under ' +
        'Settings > User Account > API.',
    );
  }

  return (await response.json()) as AccessTokenResponse;
}
