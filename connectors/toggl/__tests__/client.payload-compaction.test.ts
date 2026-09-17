/**
 * Unit tests for TogglClient — payload compaction.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { TogglClient } from '../src/client.js';
import { API_TOKEN, mockFetch, mockResponse, setupTogglClientTest } from './client.helpers.js';

describe('TogglClient', () => {
  let client: TogglClient;

  setupTogglClientTest((c) => {
    client = c;
  });

  describe('payload compaction', () => {
    describe('legacy id aliases', () => {
      it('should drop an alias that duplicates its canonical key', async () => {
        // Toggl's API definition annotates each of these as a "legacy field"
        // and documents the canonical name next to it, so both are paid for
        // twice: once in the model's context and once in the debug log.
        mockFetch.mockResolvedValue(
          mockResponse({
            id: 9,
            user_id: 1,
            uid: 1,
            workspace_id: 2,
            wid: 2,
            project_id: 3,
            pid: 3,
            task_id: 4,
            tid: 4,
          }),
        );
        await expect(client.getCurrentTimeEntry()).resolves.toEqual({
          id: 9,
          user_id: 1,
          workspace_id: 2,
          project_id: 3,
          task_id: 4,
        });
      });

      it('should keep an alias whose canonical key is absent', async () => {
        // Dropping it then would lose data, not a duplicate.
        mockFetch.mockResolvedValue(mockResponse({ id: 9, pid: 3 }));
        await expect(client.getCurrentTimeEntry()).resolves.toEqual({ id: 9, pid: 3 });
      });

      it('should keep an alias whose value differs from its canonical key', async () => {
        // `uid` is documented as the entry's *creator*, which need not be the
        // `user_id` another endpoint reports. A mismatch is data, not noise.
        mockFetch.mockResolvedValue(mockResponse({ id: 9, user_id: 1, uid: 7 }));
        await expect(client.getCurrentTimeEntry()).resolves.toEqual({
          id: 9,
          user_id: 1,
          uid: 7,
        });
      });

      it('should drop aliases nested inside a payload', async () => {
        mockFetch.mockResolvedValue(mockResponse({ id: 1, entry: { project_id: 3, pid: 3 } }));
        await expect(client.getCurrentTimeEntry()).resolves.toEqual({
          id: 1,
          entry: { project_id: 3 },
        });
      });

      it('should not drop an alias-shaped key that carries a secret', async () => {
        // Compaction runs after scrubbing and only ever deletes a key equal to
        // one that stays, so it cannot smuggle a credential past the scrubber
        // or hide that one was withheld.
        mockFetch.mockResolvedValue(
          mockResponse({ id: 1, api_token: API_TOKEN, workspace_id: 2, wid: 2 }),
        );
        const result = await client.getCurrentTimeEntry();
        expect(result).toEqual({ id: 1, api_token: '[REDACTED]', workspace_id: 2 });
        expect(JSON.stringify(result)).not.toContain(API_TOKEN);
      });
    });

    describe('listProjects envelope', () => {
      it('should wrap the page and say how to reach the next one', async () => {
        mockFetch.mockResolvedValue(mockResponse([{ id: 1, name: 'A' }]));
        const result = (await client.listProjects({ workspace_id: 42 })) as Record<string, unknown>;
        expect(result.projects).toEqual([{ id: 1, name: 'A' }]);
        expect(result.returned).toBe(1);
        expect(result.page).toBe(1);
        expect(result.per_page).toBe(50);
        expect(result.possibly_more_pages).toBe(false);
        // `false` is inference too. A short page is the ordinary sign of the
        // last one, but it looks identical to Toggl capping `per_page` below
        // what was asked for, and reading it as "no more projects" would be
        // the same overclaim the key name avoids on the other side.
        expect(result.pagination).toContain('came back short');
        expect(result.pagination).toContain('capped per_page');
      });

      it('should flag a full page as possibly-more rather than claiming has_more', async () => {
        // Toggl returns no total and no next-page link, so a full page is
        // evidence of more, not proof. The key name says which one it is.
        mockFetch.mockResolvedValue(mockResponse(Array.from({ length: 2 }, (_, i) => ({ id: i }))));
        const result = (await client.listProjects({ workspace_id: 42, per_page: 2 })) as Record<
          string,
          unknown
        >;
        expect(result.possibly_more_pages).toBe(true);
        expect(result.pagination).toContain('page 2');
        // "page 1 of 2" read the page *size* as a page *count* — asserting the
        // very number the key name refuses to assert.
        expect(result.pagination).not.toMatch(/page \d+ of \d+/);
        expect(result.pagination).toContain('number of pages is unknown');
      });

      it('should honour an explicit page and per_page', async () => {
        mockFetch.mockResolvedValue(mockResponse([]));
        await client.listProjects({ workspace_id: 42, page: 3, per_page: 200 });
        const url = String(mockFetch.mock.calls[0]?.[0]);
        expect(url).toContain('page=3');
        expect(url).toContain('per_page=200');
      });

      it('should drop null-valued keys and say that it did', async () => {
        // Generic, by value. An earlier attempt named the fields to drop on
        // the evidence that they were always null on one workspace; they are
        // real premium fields on another.
        mockFetch.mockResolvedValue(
          mockResponse([{ id: 1, name: 'A', rate: null, fixed_fee: 12, end_date: null }]),
        );
        const result = (await client.listProjects({ workspace_id: 42 })) as Record<string, unknown>;
        expect(result.projects).toEqual([{ id: 1, name: 'A', fixed_fee: 12 }]);
        expect(result.compaction_note).toContain('2 null-valued keys were removed');
        // The note must not claim a missing key was null: for a key Toggl never
        // sent, "missing means null" is exactly the "unknown" it denies.
        expect(result.compaction_note).toContain('never sent');
        expect(result.compaction_note).not.toContain('not "unknown"');
      });

      it('should say nothing about compaction when nothing was dropped', async () => {
        // The note used to be a constant, so a listing with no nulls still
        // spent a paragraph describing a transformation that did not happen —
        // in the change whose purpose is to spend less context.
        mockFetch.mockResolvedValue(mockResponse([{ id: 1, name: 'A' }]));
        const result = (await client.listProjects({ workspace_id: 42 })) as Record<string, unknown>;
        expect(result).not.toHaveProperty('compaction_note');
        expect(result).not.toHaveProperty('omitted_keys');
      });

      it('should still scrub secrets inside the envelope', async () => {
        // The envelope is built after scrubbing; it must not become a way
        // around it.
        mockFetch.mockResolvedValue(
          mockResponse([{ id: 1, ical_url: '/ical/workspace_user/synthetic-calendar-secret' }]),
        );
        const result = await client.listProjects({ workspace_id: 42 });
        expect(JSON.stringify(result)).not.toContain('synthetic-calendar-secret');
        expect(JSON.stringify(result)).toContain('[REDACTED]');
      });

      it('should pass a non-array payload through untouched', async () => {
        // Toggl answering a listing with something that is not a list is not a
        // list to compact, and an envelope around it would hide that.
        mockFetch.mockResolvedValue(mockResponse({ error: 'unexpected' }));
        await expect(client.listProjects({ workspace_id: 42 })).resolves.toEqual({
          error: 'unexpected',
        });
      });
    });

    describe('listTimeEntries envelope', () => {
      const entries = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i }));

      it('should cut to a default limit and report has_more exactly', async () => {
        // Exact, not inferred: the whole array was fetched, so whether
        // anything was cut is known. Toggl offers no limit or page on this
        // endpoint — only since/before/start_date/end_date.
        mockFetch.mockResolvedValue(mockResponse(entries(60)));
        const result = (await client.listTimeEntries({})) as Record<string, unknown>;
        expect((result.time_entries as unknown[]).length).toBe(50);
        expect(result.returned).toBe(50);
        expect(result.has_more).toBe(true);
        // Named for what it counts: what Toggl sent. "total_matching" claimed
        // it was the total for the date range, which is a different number if
        // Toggl ever caps a long range — something never verified.
        expect(result.total_received).toBe(60);
        expect(result).not.toHaveProperty('total_matching');
        expect(result.pagination).toContain('client-side');
        // The cut keeps the newest, so the rest is reached by moving the window
        // back. "Narrow the range" sent the caller towards today for entries
        // that are older than everything they were shown.
        expect(result.pagination).toContain('move the window backwards');
        expect(result.pagination).not.toContain('Narrow start_date');
      });

      it('should report has_more false when nothing was cut', async () => {
        mockFetch.mockResolvedValue(mockResponse(entries(3)));
        const result = (await client.listTimeEntries({})) as Record<string, unknown>;
        expect(result.has_more).toBe(false);
        expect(result.returned).toBe(3);
        expect(result.pagination).toBeUndefined();
      });

      it('should honour an explicit limit', async () => {
        mockFetch.mockResolvedValue(mockResponse(entries(30)));
        const result = (await client.listTimeEntries({ limit: 5 })) as Record<string, unknown>;
        expect(result.returned).toBe(5);
        expect(result.limit).toBe(5);
        expect(result.has_more).toBe(true);
      });

      it('should cap the limit', async () => {
        mockFetch.mockResolvedValue(mockResponse(entries(500)));
        const result = (await client.listTimeEntries({ limit: 10_000 })) as Record<string, unknown>;
        expect(result.limit).toBe(200);
        expect(result.returned).toBe(200);
      });

      it('should not send limit upstream, which has no such parameter', async () => {
        mockFetch.mockResolvedValue(mockResponse([]));
        await client.listTimeEntries({ limit: 5, start_date: '2024-01-01' });
        const url = String(mockFetch.mock.calls[0]?.[0]);
        expect(url).not.toContain('limit');
        expect(url).toContain('start_date=2024-01-01');
      });
    });
  });
});
