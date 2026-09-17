import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Service } from './config.js';

export function launch(service: Service, env: Record<string, string>, stdio = false): ChildProcess {
  return spawn(service.argv[0]!, service.argv.slice(1), {
    cwd: service.cwd,
    env,
    shell: false,
    detached: true,
    stdio: stdio ? ['pipe', 'pipe', 'ignore'] : 'ignore',
  });
}
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already reaped */
  }
}
export async function reap(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  const closed = exited
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.once('error', () => resolve());
      });
  signalGroup(child, 'SIGTERM');
  await Promise.race([closed, delay(500)]);
  // Kill the group even when its leader exited: descendants may still own pipes.
  signalGroup(child, 'SIGKILL');
  await closed;
}
