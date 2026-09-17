import { defineConfig } from 'vitest/config';

/**
 * The package's own Vitest config, and the `TZ` line is the reason it exists.
 *
 * `vitest run` resolves its config from the working directory only, so a
 * package without one of these runs under whatever configuration and whatever
 * zone the machine happens to have. Every date/time defect this package has had
 * was a **local-offset** defect — `pg-types` parses `date` and `timestamp` into
 * a `Date` built from the process's zone — and every one of them is invisible
 * under `TZ=UTC`, where the offset is zero. A UTC CI runner therefore proved
 * nothing about the type the tests were named after: `date` was shifted by a
 * whole calendar day for two phases with a green suite.
 *
 * So the suite is pinned to a **non-UTC** zone with a non-zero offset in both
 * halves of the year (`Europe/Prague`: +01:00 / +02:00). A parser that leaks the
 * process offset now fails here rather than in a customer's container. Tests
 * that specifically want UTC set `process.env.TZ` themselves and restore it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    env: {
      TZ: 'Europe/Prague',
    },
  },
});
