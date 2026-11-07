import { setTimeout as nativeTimer } from 'node:timers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoogleTasksServer } from '../../google/src/tasks.js';
import { OutlookMailServer } from '../src/mail.js';

const dns = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dns }));
beforeEach(() => {
  dns.mockReset().mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const credential = {
  apiKey: 'synthetic-token',
  headerName: 'Authorization',
  headerValue: 'synthetic-token',
};
const services = [
  ['Microsoft', () => new OutlookMailServer(credential), 'mail_list_folders'],
  ['Google', () => new GoogleTasksServer(credential), 'tasks_list_tasklists'],
] as const;
function stalledDns() {
  let ready!: () => void;
  let release!: () => void;
  const received = new Promise<void>((r) => {
    ready = r;
  });
  const released = new Promise<void>((r) => {
    release = r;
  });
  dns.mockImplementation(async () => {
    ready();
    await released;
    return [{ address: '203.0.113.10', family: 4 }];
  });
  return { received, release };
}
for (const [label, make, name] of services) {
  it(`${label}: refuses redirects without forwarding the delegated bearer`, async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://other.example/path' } }),
      )
      .mockResolvedValueOnce(Response.json({ value: [] }));
    vi.stubGlobal('fetch', fetch);
    expect(await make().callTool(name, {})).toHaveProperty('isError', true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it(`${label}: caller cancellation completes without waiting for DNS and forbids later dispatch`, async () => {
    const gate = stalledDns();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: [] }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = make().callTool(name, {}, { signal: controller.signal });
    await gate.received;
    controller.abort();
    let outcome: unknown;
    try {
      outcome = await Promise.race([
        pending.then(() => 'completed'),
        new Promise((resolve) => nativeTimer(() => resolve('still-waiting'), 50)),
      ]);
    } finally {
      gate.release();
      await pending;
    }
    expect(outcome).toBe('completed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it(`${label}: its twenty-second timer completes even if DNS never responds`, async () => {
    vi.useFakeTimers();
    const gate = stalledDns();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: [] }));
    vi.stubGlobal('fetch', fetch);
    const pending = make().callTool(name, {});
    await gate.received;
    await vi.advanceTimersByTimeAsync(20_001);
    let outcome: unknown;
    try {
      outcome = await Promise.race([
        pending.then(() => 'completed'),
        new Promise((resolve) => nativeTimer(() => resolve('still-waiting'), 50)),
      ]);
    } finally {
      gate.release();
      await pending;
    }
    expect(outcome).toBe('completed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it(`${label}: refuses a DNS-delayed dispatch after monotonic expiry before timers run`, async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const gate = stalledDns();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: [] }));
    vi.stubGlobal('fetch', fetch);
    const pending = make().callTool(name, {});
    await gate.received;
    now.mockReturnValue(30_000);
    gate.release();
    expect(await pending).toHaveProperty('isError', true);
    expect(fetch).not.toHaveBeenCalled();
  });
}
