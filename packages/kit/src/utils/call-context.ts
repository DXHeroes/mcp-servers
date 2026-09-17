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
