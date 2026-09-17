import { afterEach, expect, it, vi } from 'vitest';
import { GeminiClient } from '../src/gemini-client.js';

const mock = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), cancel: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    interactions = mock;
  },
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
const client = () => new GeminiClient('synthetic-cancel-test');
it('aborts provider creation with the request and never starts a polling task', async () => {
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  mock.create.mockImplementation(
    (_body, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
        started();
      }),
  );
  const controller = new AbortController();
  const result = client().deepResearch({ topic: 'synthetic' }, { signal: controller.signal });
  const rejected = expect(result).rejects.toThrow('fixture cancelled');
  await begun;
  controller.abort(new Error('fixture cancelled'));
  await rejected;
  expect(mock.get).not.toHaveBeenCalled();
  expect(mock.cancel).not.toHaveBeenCalled();
});
it('aborts in-flight polling and performs bounded provider cancellation', async () => {
  mock.create.mockResolvedValue({ id: 'synthetic-interaction' });
  mock.cancel.mockResolvedValue({ status: 'cancelled' });
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  mock.get.mockImplementation(
    (_id, _body, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
        started();
      }),
  );
  const controller = new AbortController();
  const result = client().deepResearch({ topic: 'synthetic' }, { signal: controller.signal });
  const rejected = expect(result).rejects.toThrow('fixture cancelled');
  await begun;
  controller.abort(new Error('fixture cancelled'));
  await rejected;
  expect(mock.cancel).toHaveBeenCalledWith(
    'synthetic-interaction',
    undefined,
    expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }),
  );
});
it('cancels during the ten-second sleep without another provider poll', async () => {
  mock.create.mockResolvedValue({ id: 'synthetic-interaction' });
  mock.get.mockResolvedValue({ status: 'in_progress' });
  mock.cancel.mockResolvedValue({ status: 'cancelled' });
  let progressed!: () => void;
  const progress = new Promise<void>((resolve) => {
    progressed = resolve;
  });
  const controller = new AbortController();
  const result = client().deepResearch(
    { topic: 'synthetic' },
    {
      signal: controller.signal,
      onProgress: async () => {
        progressed();
      },
    },
  );
  const rejected = expect(result).rejects.toThrow();
  await progress;
  controller.abort();
  await rejected;
  expect(mock.get).toHaveBeenCalledTimes(1);
  expect(mock.cancel).toHaveBeenCalledTimes(1);
});
it('enforces the absolute sixty-minute bound even while provider creation hangs', async () => {
  vi.useFakeTimers();
  mock.create.mockImplementation(
    (_body, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      }),
  );
  const result = client().deepResearch({ topic: 'synthetic' });
  const rejected = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(3600000);
  await rejected;
  expect(mock.get).not.toHaveBeenCalled();
});
