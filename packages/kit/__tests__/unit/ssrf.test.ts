import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPrivateAddress, safeFetch } from '../../src/utils/ssrf.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockImplementation(async (hostname: string, opts?: { all?: boolean }) => {
    const hosts: Record<string, string[]> = {
      'example.com': ['93.184.216.34'],
      'other.example.com': ['93.184.216.35'],
      'evil-rebind.com': ['169.254.169.254'],
      'multi-record.com': ['93.184.216.34', '10.0.0.1'],
    };
    if (hosts[hostname]) {
      if (opts?.all) {
        return hosts[hostname].map((address) => ({
          address,
          family: address.includes(':') ? 6 : 4,
        }));
      }
      return { address: hosts[hostname][0] };
    }
    throw new Error(`DNS lookup failed: ${hostname}`);
  }),
}));

describe('isPrivateAddress', () => {
  it('should detect IPv4 private ranges', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
  });

  it('should allow public IPv4', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });

  it('should detect IPv4-mapped hex form (bypass vector)', () => {
    // ::ffff:a9fe:a9fe = 169.254.169.254
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true);
    // ::ffff:a00:1 = 10.0.0.1
    expect(isPrivateAddress('::ffff:a00:1')).toBe(true);
    // ::ffff:7f00:1 = 127.0.0.1
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    // Public: ::ffff:5db8:d822 = 93.184.216.34
    expect(isPrivateAddress('::ffff:5db8:d822')).toBe(false);
  });

  it('should detect full fe80::/10 range', () => {
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fe90::1')).toBe(true);
    expect(isPrivateAddress('febf::1')).toBe(true);
    expect(isPrivateAddress('fec0::1')).toBe(false);
  });

  it('should detect full fc00::/7 range', () => {
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fc01::1')).toBe(true);
    expect(isPrivateAddress('fd80::1')).toBe(true);
    expect(isPrivateAddress('fdff::1')).toBe(true);
    expect(isPrivateAddress('fe00::1')).toBe(false);
  });

  it('should detect :: (all-zeros)', () => {
    expect(isPrivateAddress('::')).toBe(true);
  });

  it('should allow loopback and private ranges with allowPrivate', () => {
    expect(isPrivateAddress('127.0.0.1', true)).toBe(false);
    expect(isPrivateAddress('::1', true)).toBe(false);
    expect(isPrivateAddress('10.1.2.3', true)).toBe(false);
    expect(isPrivateAddress('172.16.0.1', true)).toBe(false);
    expect(isPrivateAddress('192.168.1.1', true)).toBe(false);
    expect(isPrivateAddress('100.64.0.1', true)).toBe(false);
    expect(isPrivateAddress('fd00::1', true)).toBe(false);
  });

  it('should still block link-local and unspecified with allowPrivate', () => {
    expect(isPrivateAddress('0.0.0.0', true)).toBe(true);
    expect(isPrivateAddress('::', true)).toBe(true);
    expect(isPrivateAddress('169.254.169.254', true)).toBe(true);
    expect(isPrivateAddress('169.254.0.1', true)).toBe(true);
    expect(isPrivateAddress('fe80::1', true)).toBe(true);
    // IPv4-mapped IPv6 forms of the metadata endpoint
    expect(isPrivateAddress('::ffff:169.254.169.254', true)).toBe(true);
    expect(isPrivateAddress('::ffff:a9fe:a9fe', true)).toBe(true);
  });
});

describe('safeFetch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return response for non-redirect status', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    const result = await safeFetch('https://example.com');
    expect(result.status).toBe(200);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('should follow safe redirects', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'https://other.example.com/path' },
    });
    const finalResponse = new Response('final', { status: 200 });

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(finalResponse);

    const result = await safeFetch('https://example.com');
    expect(result.status).toBe(200);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('should block redirect to private IP', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectResponse);

    await expect(safeFetch('https://example.com')).rejects.toThrow('resolves to a private address');
  });

  it('should block redirect to loopback', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1:8080/admin' },
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectResponse);

    await expect(safeFetch('https://example.com')).rejects.toThrow('resolves to a private address');
  });

  it('should block redirect to 10.x.x.x', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'http://10.0.0.1/internal' },
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectResponse);

    await expect(safeFetch('https://example.com')).rejects.toThrow('resolves to a private address');
  });

  it('should enforce max redirects', async () => {
    const makeRedirect = () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/loop' },
      });

    vi.mocked(globalThis.fetch).mockResolvedValue(makeRedirect());

    await expect(safeFetch('https://example.com', { maxRedirects: 3 })).rejects.toThrow(
      'Too many redirects',
    );
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(4); // initial + 3 redirects
  });

  it('should reject initial URL with private IP', async () => {
    await expect(safeFetch('http://10.0.0.1/api')).rejects.toThrow('resolves to a private address');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('should handle relative redirects', async () => {
    const redirectResponse = new Response(null, {
      status: 307,
      headers: { location: '/new-path' },
    });
    const finalResponse = new Response('final', { status: 200 });

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(finalResponse);

    const result = await safeFetch('https://example.com/old-path');
    expect(result.status).toBe(200);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenLastCalledWith(
      'https://example.com/new-path',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('should block hostname-based redirect that resolves to private IP (DNS rebinding)', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'http://evil-rebind.com/steal' },
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectResponse);

    await expect(safeFetch('https://example.com')).rejects.toThrow(
      'resolves to private address 169.254.169.254',
    );
  });

  it('should block initial hostname that resolves to private IP', async () => {
    await expect(safeFetch('https://evil-rebind.com/api')).rejects.toThrow(
      'resolves to private address 169.254.169.254',
    );
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('should block when any DNS record is private (multi-record rebinding)', async () => {
    await expect(safeFetch('https://multi-record.com/api')).rejects.toThrow(
      'resolves to private address 10.0.0.1',
    );
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('should allow localhost when allowPrivate is true', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    const result = await safeFetch('http://127.0.0.1:3000/api', { allowPrivate: true });
    expect(result.status).toBe(200);
  });

  it('should allow private IPs when allowPrivate is true', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    const result = await safeFetch('http://10.0.0.1/api', { allowPrivate: true });
    expect(result.status).toBe(200);
  });

  it('should follow redirect to private IP when allowPrivate is true', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'http://192.168.1.10/internal' },
    });
    const finalResponse = new Response('final', { status: 200 });

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(finalResponse);

    const result = await safeFetch('https://example.com', { allowPrivate: true });
    expect(result.status).toBe(200);
  });

  it('should still block metadata endpoint when allowPrivate is true', async () => {
    await expect(
      safeFetch('http://169.254.169.254/latest/meta-data', { allowPrivate: true }),
    ).rejects.toThrow('resolves to a private address');
  });

  it('should still block redirect to metadata endpoint when allowPrivate is true', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(redirectResponse);

    await expect(safeFetch('https://example.com', { allowPrivate: true })).rejects.toThrow(
      'resolves to a private address',
    );
  });
});
