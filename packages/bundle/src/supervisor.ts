import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { processEnvironment, type Service } from './config.js';
import { launch, reap } from './process.js';

export class Supervisor {
  private stopping = false;
  private children = new Map<string, ChildProcess>();
  private jobs: Promise<void>[] = [];
  readonly states = new Map<string, { status: string; restarts: number }>();
  constructor(private services: Service[]) {}
  start(): void {
    for (const service of this.services) {
      this.states.set(service.id, {
        status: service.transport === 'stdio' ? 'on_demand' : 'starting',
        restarts: 0,
      });
      if (service.transport === 'http') this.jobs.push(this.run(service));
    }
  }
  private async run(service: Service): Promise<void> {
    const state = this.states.get(service.id)!;
    for (let attempt = 0; attempt < 4 && !this.stopping; attempt++) {
      state.restarts = attempt;
      state.status = 'starting';
      const child = launch(
        service,
        processEnvironment(
          service,
          service.credentialModes.includes('shared') ? service.sharedCredential : undefined,
        ),
      );
      this.children.set(service.id, child);
      let ended = false;
      const exit = new Promise<void>((resolve) => {
        const done = () => {
          ended = true;
          resolve();
        };
        child.once('exit', done);
        child.once('error', done);
      });
      const deadline = Date.now() + 10000;
      while (!ended && !this.stopping && Date.now() < deadline) {
        if (await probe(service.port!)) {
          state.status = 'ready';
          break;
        }
        await delay(50);
      }
      if (state.status !== 'ready' || this.stopping) await reap(child);
      await exit;
      await reap(child);
      this.children.delete(service.id);
      state.status = this.stopping ? 'stopped' : 'restarting';
      if (!this.stopping) await delay(100 * 2 ** attempt);
    }
    state.status = this.stopping ? 'stopped' : 'failed';
  }
  async close(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.children.values()].map(reap));
    await Promise.all(this.jobs);
  }
}
function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 250 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
