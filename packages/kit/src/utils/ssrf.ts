import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { callSignal } from './call-context.js';

/**
 * Converts an IPv6 address to a 128-bit BigInt.
 * Handles full, abbreviated, and :: (zero-compression) notation.
 */
function ipv6ToBigInt(ip: string): bigint {
  const halves = ip.split('::');
  let groups: string[];

  if (halves.length === 2) {
    const left = halves[0] ?? '';
    const right = halves[1] ?? '';
    const head = left === '' ? [] : left.split(':');
    const tail = right === '' ? [] : right.split(':');
    const missing = 8 - head.length - tail.length;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = ip.split(':');
  }

  const hex = groups.map((g) => g.padStart(4, '0')).join('');
  return BigInt(`0x${hex}`);
}

function isInIpv6Prefix(ip: string, prefix: string, prefixLen: number): boolean {
  const addr = ipv6ToBigInt(ip);
  const net = ipv6ToBigInt(prefix);
  const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefixLen)) - 1n);
  return (addr & mask) === (net & mask);
}

/**
 * Returns true if the IP address belongs to a private, loopback,
 * link-local, or cloud-metadata range.
 *
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 (both dotted and hex forms).
 *
 * With `allowPrivate`, loopback, RFC 1918, CGNAT, and ULA ranges pass;
 * unspecified (0.0.0.0, ::) and link-local ranges (incl. the cloud
 * metadata endpoint 169.254.169.254) are still reported as private.
 */
export function isPrivateAddress(ip: string, allowPrivate = false): boolean {
  // IPv4-mapped IPv6 — dotted form (::ffff:1.2.3.4)
  const v4MappedDotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedDotted?.[1]) return isPrivateAddress(v4MappedDotted[1], allowPrivate);

  // IPv4-mapped IPv6 — hex form (::ffff:a9fe:a9fe = 169.254.169.254)
  const v4MappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4MappedHex?.[1] && v4MappedHex[2]) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateAddress(dotted, allowPrivate);
  }

  if (ip === '0.0.0.0' || ip === '::') return true;
  if (!allowPrivate && (ip === '127.0.0.1' || ip === '::1')) return true;

  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    const [a, b] = parts as [number, number, number, number];
    if (!allowPrivate && a === 127) return true;
    if (!allowPrivate && a === 10) return true;
    if (!allowPrivate && a === 172 && b >= 16 && b <= 31) return true;
    if (!allowPrivate && a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (!allowPrivate && a === 100 && b >= 64 && b <= 127) return true;
  }

  // IPv6 prefix checks using proper CIDR matching
  const lower = ip.toLowerCase();
  if (lower.includes(':')) {
    if (isInIpv6Prefix(lower, 'fe80::', 10)) return true;
    if (!allowPrivate && isInIpv6Prefix(lower, 'fc00::', 7)) return true;
    if (!allowPrivate && ipv6ToBigInt(lower) === 1n) return true;
  }

  return false;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeFetchOptions extends RequestInit {
  /** Maximum number of redirects to follow (default: 5) */
  maxRedirects?: number;
  /**
   * When true, allow private-network targets (loopback, RFC 1918, CGNAT,
   * ULA) through SSRF checks. Unspecified and link-local addresses
   * (incl. cloud metadata) stay blocked.
   */
  allowPrivate?: boolean;
}

/**
 * A fetch wrapper that follows redirects manually and validates each
 * redirect target against private IP ranges to prevent SSRF.
 *
 * For every hop (initial URL + each redirect), performs:
 * 1. IP-literal check against `isPrivateAddress`
 * 2. DNS resolution of hostnames with validation of all resolved addresses
 *
 * The DNS pre-resolution closes the redirect-hostname gap where a redirect
 * to a hostname (not an IP literal) was previously unvalidated. While the
 * subsequent `fetch()` re-resolves DNS independently (a narrow TOCTOU
 * window), this defense-in-depth layer makes DNS rebinding significantly
 * harder to exploit.
 */
export async function safeFetch(input: string | URL, init?: SafeFetchOptions): Promise<Response> {
  const { maxRedirects = MAX_REDIRECTS, allowPrivate = false, ...fetchInit } = init ?? {};
  const signal = callSignal(fetchInit.signal);
  if (signal) fetchInit.signal = signal;
  signal?.throwIfAborted();
  let url = typeof input === 'string' ? input : input.toString();
  let remaining = maxRedirects;

  await validateUrlHost(url, allowPrivate);

  while (true) {
    const response = await fetch(url, { ...fetchInit, redirect: 'manual' });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (remaining <= 0) {
      throw new Error(`Too many redirects (max ${maxRedirects})`);
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    // Resolve relative redirect
    url = new URL(location, url).toString();
    await validateUrlHost(url, allowPrivate);
    remaining--;

    // 303 always becomes GET; 301/302 become GET for non-GET/HEAD (browser semantics)
    if (response.status === 303) {
      (fetchInit as Record<string, unknown>).method = 'GET';
      delete (fetchInit as Record<string, unknown>).body;
    }
  }
}

/**
 * Validates that a URL's host is not a private/loopback/link-local address.
 * For IP literals, checks directly. For hostnames, performs DNS resolution
 * and validates every resolved address.
 */
async function validateUrlHost(url: string, allowPrivate = false): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname, allowPrivate)) {
      throw new Error(`Request blocked: "${hostname}" resolves to a private address`);
    }
    return;
  }

  // DNS-resolve hostnames and validate all addresses
  try {
    const results = await lookup(hostname, { all: true });
    for (const result of results) {
      if (isPrivateAddress(result.address, allowPrivate)) {
        throw new Error(
          `Request blocked: "${hostname}" resolves to private address ${result.address}`,
        );
      }
    }
  } catch (error) {
    // Re-throw our own SSRF blocks; swallow DNS failures (let fetch handle them)
    if (error instanceof Error && error.message.startsWith('Request blocked:')) {
      throw error;
    }
  }
}
