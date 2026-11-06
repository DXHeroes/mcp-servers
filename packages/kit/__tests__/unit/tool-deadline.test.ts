import { afterEach, expect, it, vi } from 'vitest';
import {
  callSignal,
  checkToolCallDeadline,
  withToolCallContext,
  withToolCallDeadline,
} from '../../src/utils/call-context.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('disposes its signal and timer after success without aborting its caller', async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  expect(
    await withToolCallDeadline(
      1000,
      async () => {
        signal = callSignal();
        return 42;
      },
      { signal: controller.signal },
    ),
  ).toBe(42);
  expect(signal?.aborted).toBe(true);
  expect(controller.signal.aborted).toBe(false);
});
it('never lets a nested budget extend its parent deadline', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  await expect(
    withToolCallDeadline(20, async () => {
      now.mockReturnValue(10);
      return withToolCallDeadline(1000, async () => {
        now.mockReturnValue(25);
        checkToolCallDeadline();
        return 'late';
      });
    }),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
});
it('retains an ambient caller abort when no explicit context is supplied', async () => {
  await expect(
    withToolCallContext({ signal: AbortSignal.abort() }, () =>
      withToolCallDeadline(1000, async () => 42),
    ),
  ).rejects.toBeDefined();
});
it.each([0, -1, Infinity, NaN])(
  'refuses invalid deadline %s without invoking work',
  async (timeout) => {
    const run = vi.fn(async () => 42);
    await expect(withToolCallDeadline(timeout, run)).rejects.toThrow('Invalid tool deadline');
    expect(run).not.toHaveBeenCalled();
  },
);
it('prefers monotonic expiry to a late provider failure before the timer dispatches', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  await expect(
    withToolCallDeadline(20, async () => {
      now.mockReturnValue(25);
      throw new Error('Late provider failure');
    }),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
});
