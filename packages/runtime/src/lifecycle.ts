/** Absolute and idle deadlines are independent of SDK client timeout behavior. */
export function requestBudget(parent: AbortSignal, totalMs: number, idleMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Request cancelled or deadline exceeded'));
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const total = setTimeout(abort, totalMs);
  let idle = setTimeout(abort, idleMs);
  return {
    signal: controller.signal,
    progress() {
      clearTimeout(idle);
      idle = setTimeout(abort, idleMs);
    },
    dispose() {
      clearTimeout(total);
      clearTimeout(idle);
      parent.removeEventListener('abort', abort);
    },
  };
}
