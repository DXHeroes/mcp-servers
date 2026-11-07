import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolCallContext } from '../abstractions/McpServer.js';

const calls = new AsyncLocalStorage<ToolCallContext>();
/** Async-local context follows one call without mutating shared credentials or clients. */
export function withToolCallContext<T>(
  context: ToolCallContext,
  run: () => Promise<T>,
): Promise<T> {
  return calls.run(context, run);
}
export function callSignal(existing?: AbortSignal | null): AbortSignal | undefined {
  const signal = calls.getStore()?.signal;
  return signal && existing
    ? AbortSignal.any([signal, existing])
    : (signal ?? existing ?? undefined);
}
export function callDelay(ms: number): Promise<void> {
  return delay(ms, undefined, { signal: callSignal() });
}

interface ToolDeadline {
  expiresAt: number;
  controller: AbortController;
}
const deadlines = new AsyncLocalStorage<ToolDeadline>();
const deadlineError = () => new DOMException('Tool deadline exceeded', 'TimeoutError');

/** Check monotonic expiry as well as cancellation, including when timer dispatch is delayed. */
export function checkToolCallDeadline(): void {
  const deadline = deadlines.getStore();
  if (deadline && performance.now() >= deadline.expiresAt)
    deadline.controller.abort(deadlineError());
  callSignal()?.throwIfAborted();
}

/** Bound completion even when a collaborator (for example DNS) cannot observe cancellation. */
export async function withToolCallDeadline<T>(
  timeoutMs: number,
  run: () => Promise<T>,
  context?: ToolCallContext,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid tool deadline');
  const controller = new AbortController();
  const expiresAt = Math.min(
    performance.now() + timeoutMs,
    deadlines.getStore()?.expiresAt ?? Infinity,
  );
  const signal = AbortSignal.any(
    [controller.signal, callSignal(), context?.signal].filter((s): s is AbortSignal => Boolean(s)),
  );
  const timer = setTimeout(
    () => controller.abort(deadlineError()),
    Math.max(0, expiresAt - performance.now()),
  );
  timer.unref?.();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await deadlines.run({ expiresAt, controller }, () =>
      withToolCallContext({ ...context, signal }, async () => {
        const value = await Promise.race([
          Promise.resolve().then(() => {
            checkToolCallDeadline();
            return run();
          }),
          cancelled,
        ]).catch((error) => {
          checkToolCallDeadline();
          throw error;
        });
        checkToolCallDeadline();
        return value;
      }),
    );
  } finally {
    signal.removeEventListener('abort', onAbort);
    clearTimeout(timer);
    controller.abort();
  }
}
