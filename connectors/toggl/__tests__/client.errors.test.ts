/**
 * Unit tests for TogglClient — error handling, error messages and hints.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { TogglClient } from '../src/client.js';
import { buildErrorHint, extractErrorMessage, TogglApiError } from '../src/client.js';
import { mockFetch, mockResponse, setupTogglClientTest } from './client.helpers.js';

describe('TogglClient', () => {
  let client: TogglClient;

  setupTogglClientTest((c) => {
    client = c;
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('should throw INVALID_API_KEY on 401', async () => {
      mockFetch.mockResolvedValue(mockResponse('Unauthorized', 401));
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TogglApiError);
        expect((e as TogglApiError).code).toBe('INVALID_API_KEY');
        expect((e as TogglApiError).status).toBe(401);
      }
    });

    it('should throw FORBIDDEN on 403', async () => {
      mockFetch.mockResolvedValue(mockResponse('Forbidden', 403));
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TogglApiError);
        expect((e as TogglApiError).code).toBe('FORBIDDEN');
      }
    });

    it('should throw PAYMENT_REQUIRED on 402', async () => {
      mockFetch.mockResolvedValue(mockResponse('Payment required', 402));
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TogglApiError);
        expect((e as TogglApiError).code).toBe('PAYMENT_REQUIRED');
      }
    });

    it('should throw NOT_FOUND on 404', async () => {
      mockFetch.mockResolvedValue(mockResponse('Not found', 404));
      try {
        await client.getWorkspace({ workspace_id: 999 });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TogglApiError);
        expect((e as TogglApiError).code).toBe('NOT_FOUND');
      }
    });

    it('should throw RATE_LIMITED on 429', async () => {
      mockFetch.mockResolvedValue(mockResponse('Too many requests', 429));
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TogglApiError);
        expect((e as TogglApiError).code).toBe('RATE_LIMITED');
      }
    });

    it('should throw BAD_REQUEST on 400', async () => {
      mockFetch.mockResolvedValue(mockResponse('Bad request', 400));
      try {
        await client.createTimeEntry({
          workspace_id: 42,
          start: 'invalid',
          duration: -1,
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TogglApiError);
        expect((e as TogglApiError).code).toBe('BAD_REQUEST');
      }
    });

    it('should throw API_ERROR on 500', async () => {
      mockFetch.mockResolvedValue(mockResponse('Server error', 500));
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TogglApiError);
        expect((e as TogglApiError).code).toBe('API_ERROR');
      }
    });
  });

  // ── Error message shape and hints  ───────────────────────

  describe('error message', () => {
    async function captureError(status: number, body: unknown): Promise<TogglApiError> {
      mockFetch.mockResolvedValue(mockResponse(body, status));
      try {
        await client.me({});
      } catch (e) {
        return e as TogglApiError;
      }
      throw new Error('Should have thrown');
    }

    it('should not prefix the error code onto the message', async () => {
      const error = await captureError(400, 'start: invalid date');
      expect(error.message).toBe('start: invalid date');
      expect(error.message).not.toContain('BAD_REQUEST');
    });

    it('should unwrap a JSON string body instead of nesting JSON', async () => {
      // Toggl returns some errors as a bare JSON string: `"Time entry not found"`.
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('"Time entry not found"'),
        json: () => Promise.resolve('Time entry not found'),
      });
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as TogglApiError).message).toBe('Time entry not found');
      }
    });

    it('should unwrap a JSON object body', async () => {
      const error = await captureError(400, { error: 'Invalid project_id' });
      expect(error.message).toBe('Invalid project_id');
    });

    it('should unwrap a nested errors array', async () => {
      const error = await captureError(400, { errors: ['name must not be blank'] });
      expect(error.message).toBe('name must not be blank');
    });

    it('should keep a plain-text body verbatim', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('workspace_id is required'),
        json: () => Promise.reject(new Error('not json')),
      });
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as TogglApiError).message).toBe('workspace_id is required');
      }
    });

    it('should fall back to the status text on an empty body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve(''),
        json: () => Promise.reject(new Error('no body')),
      });
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as TogglApiError).message).toBe('Internal Server Error');
      }
    });

    it('should read the message out of a field-keyed validation body', async () => {
      // The shape Toggl actually returns for a rejected report range. The key
      // walk dead-ends on `start_date`, and falling back to the status text
      // ("Error") threw away the only sentence that says what is wrong.
      const error = await captureError(400, {
        errors: { start_date: ['must not be after end_date'] },
      });
      expect(error.message).toBe('start_date: must not be after end_date');
      // Compounding: the hint matches on the message, so losing the message
      // lost the hint as well.
      expect(error.hint).toContain('date-only');
    });

    it('should not re-serialise the body while recovering the message', async () => {
      const error = await captureError(400, { unexpected: 'shape' });
      expect(error.message).toBe('unexpected: shape');
      expect(error.message).not.toContain('{');
      expect(error.message).not.toContain('"');
    });

    it('should fall back to the status text only when the body has no text at all', async () => {
      const error = await captureError(400, { count: 3 });
      expect(error.message).toBe('Error');
    });
  });

  describe('error hints', () => {
    // These messages are the phrasings Toggl actually returns — snake_case
    // field names included. Hints tested against hand-made prose ("Invalid
    // start date") only prove the regex matches itself.
    async function captureError(
      status: number,
      body: unknown,
      call: () => Promise<unknown> = () => client.me({}),
    ): Promise<TogglApiError> {
      mockFetch.mockResolvedValue(mockResponse(body, status));
      try {
        await call();
      } catch (e) {
        return e as TogglApiError;
      }
      throw new Error('Should have thrown');
    }

    it('should hint the date formats on a snake_case date range error', async () => {
      const error = await captureError(400, 'start_date must not be after end_date', () =>
        client.reportSummary({ workspace_id: 1, start_date: '2024-02-01', end_date: '2024-01-01' }),
      );
      expect(error.hint).toContain('2024-01-15');
      expect(error.hint).toContain('start_date');
    });

    it('should hint the date formats on a snake_case timestamp error', async () => {
      const error = await captureError(400, 'start_time is not a valid timestamp', () =>
        client.createTimeEntry({ workspace_id: 1, start: 'nope', duration: 60 }),
      );
      expect(error.hint).toContain('RFC 3339');
    });

    it('should answer a grouping error with grouping advice, not a project lookup', async () => {
      const error = await captureError(
        400,
        'invalid sub_grouping projects for grouping projects',
        () =>
          client.reportSummary({
            workspace_id: 1,
            start_date: '2024-01-01',
            end_date: '2024-01-31',
            grouping: 'projects',
            sub_grouping: 'projects',
          }),
      );
      expect(error.hint).toContain('sub_grouping');
      // `toggl_report_summary` has no `project_id`, so pointing the caller at
      // one is worse than saying nothing.
      expect(error.hint).not.toContain('toggl_list_projects');
    });

    it('should not answer a task sub_grouping error with a task lookup', async () => {
      const error = await captureError(400, 'invalid sub_grouping tasks for grouping users', () =>
        client.reportSummary({
          workspace_id: 1,
          start_date: '2024-01-01',
          end_date: '2024-01-31',
          sub_grouping: 'tasks',
        }),
      );
      expect(error.hint).not.toContain('toggl_list_tasks');
    });

    it('should hint the client status values only on the clients endpoint', async () => {
      const error = await captureError(400, 'Client status is invalid', () =>
        client.listClients({ workspace_id: 1, status: 'both' }),
      );
      expect(error.hint).toContain('"active"');
      expect(error.hint).toContain('"archived"');
      expect(error.hint).toContain('"both"');
    });

    it('should not lecture about the client status filter on a project error', async () => {
      const error = await captureError(400, 'Invalid project status', () =>
        client.createProject({ workspace_id: 1, name: 'X' }),
      );
      expect(error.hint).not.toContain('"archived"');
      expect(error.hint).toContain('toggl_list_projects');
    });

    it('should point at toggl_list_tasks for a task error on a task endpoint', async () => {
      const error = await captureError(400, 'task_id is invalid', () =>
        client.listTasks({ workspace_id: 1 }),
      );
      expect(error.hint).toContain('toggl_list_tasks');
    });

    it('should point at toggl_list_tasks when assigning a task to a time entry', async () => {
      const error = await captureError(400, 'Task not found in project', () =>
        client.createTimeEntry({
          workspace_id: 1,
          project_id: 2,
          task_id: 3,
          start: '2024-01-15T09:00:00Z',
          duration: 60,
        }),
      );
      expect(error.hint).toContain('toggl_list_tasks');
    });

    it('should not send the caller looking for a task_id when it asked to clear one', async () => {
      const error = await captureError(400, 'task_id must not be null', () =>
        client.updateTimeEntry({ workspace_id: 1, time_entry_id: 2, task_id: null }),
      );
      expect(error.hint).not.toContain('toggl_list_tasks');
      expect(error.hint).toContain('nullable');
    });

    it('should explain the rate limit on 429', async () => {
      const error = await captureError(429, 'Too many requests');
      expect(error.hint).toContain('one request per second');
    });

    it('should mention the paid plan for a 403 on a task endpoint', async () => {
      const error = await captureError(403, 'Forbidden', () =>
        client.listTasks({ workspace_id: 1 }),
      );
      expect(error.hint).toContain('paid');
      expect(error.hint).toContain('Starter');
    });

    it('should mention the paid plan for a 403 on a time entry carrying a task_id', async () => {
      // `/workspaces/{ws}/time_entries` contains no "/tasks", so only the
      // request itself reveals that a paid feature was used.
      const error = await captureError(403, 'Forbidden', () =>
        client.createTimeEntry({
          workspace_id: 1,
          project_id: 2,
          task_id: 3,
          start: '2024-01-15T09:00:00Z',
          duration: 60,
        }),
      );
      expect(error.hint).toContain('paid');
      expect(error.hint).toContain('Starter');
    });

    it('should not blame the token for a non-task 403', async () => {
      const error = await captureError(403, 'Forbidden');
      expect(error.hint).toContain('valid but not allowed');
    });

    it('should explain a 402 on client archiving without mentioning tasks', async () => {
      const error = await captureError(402, 'Payment required', () =>
        client.archiveClient({ workspace_id: 1, client_id: 2 }),
      );
      expect(error.hint).toContain('archiving');
      expect(error.hint).not.toContain('Starter');
      // Falling back to a delete is the failure mode this hint exists to stop.
      expect(error.hint).toContain('toggl_delete_client');
    });

    it('should keep a 402 elsewhere generic instead of talking about tasks', async () => {
      const error = await captureError(402, 'Payment required', () =>
        client.createProject({ workspace_id: 1, name: 'X' }),
      );
      expect(error.hint).not.toContain('Starter');
      expect(error.hint).toContain('paid plans');
    });

    it('should leave the hint undefined when nothing useful can be said', async () => {
      const error = await captureError(500, 'boom');
      expect(error.hint).toBeUndefined();
    });

    it.each([
      [
        'an identifier that merely starts with a date word',
        'Name has already been taken: start_2024',
      ],
      ['a field whose prefix is a date word', 'end_customer_id is invalid'],
      ['a name that ends in a date word', 'Tag week_start already exists'],
      ['a project called Front_end', 'Project Front_end could not be updated'],
    ])('should not answer %s with a date-format hint', (_label, message) => {
      // The hint fires on a *date field*, not on any identifier containing a
      // date word. An earlier pattern allowed the date word any suffix at all,
      // which turned every name clash into a lecture about RFC 3339.
      // `?? ''` because "no hint at all" is the expected outcome here, and a
      // bare `.not.toContain` on undefined fails the assertion rather than
      // passing it.
      expect(buildErrorHint('BAD_REQUEST', message, '/workspaces/1/projects') ?? '').not.toContain(
        'date format',
      );
    });

    it.each([
      ['start_date must not be after end_date'],
      ['invalid start_time'],
      ['duration must be an integer'],
      ['stop is before start'],
      ['end date is required'],
    ])('should still answer a real date complaint (%s)', (message) => {
      expect(buildErrorHint('BAD_REQUEST', message, '/workspaces/1/time_entries')).toContain(
        'date format',
      );
    });

    it.each([
      ['project', '{"errors":{"project_name":["is too long"]}}', '/workspaces/1/projects'],
      ['workspace', '{"errors":{"workspace_name":["is invalid"]}}', '/workspaces/1/projects'],
      ['task', '{"errors":{"task_name":["is too long"]}}', '/workspaces/1/projects/2/tasks'],
      ['client', '{"errors":{"client_name":["is too long"]}}', '/workspaces/1/clients'],
    ])(
      'should not send the model hunting for an id when a %s attribute was rejected',
      (_entity, body, path) => {
        // The leaf fallback labels the failure with its field, so this arrives
        // as `project_name: is too long`. A substring test for "project" read
        // that as a bad id and answered "look up a valid project_id" — after
        // being told a *name* was too long.
        const message = extractErrorMessage(body, 'Bad Request');
        // The upstream text still reaches the caller — it is the hint that must
        // not turn an attribute complaint into an id lookup.
        expect(message).toContain('_name: ');
        expect(buildErrorHint('BAD_REQUEST', message, path) ?? '').not.toContain('look up');
      },
    );

    it.each([
      ['Invalid project_id', '/workspaces/1/time_entries', 'toggl_list_projects'],
      ['project not found', '/workspaces/1/time_entries', 'toggl_list_projects'],
      ['project_ids must be an array', '/workspace/1/summary/time_entries', 'toggl_list_projects'],
      ['invalid workspace_id', '/workspaces/1/projects', 'toggl_list_workspaces'],
      ['Invalid task_id', '/workspaces/1/projects/2/tasks', 'toggl_list_tasks'],
    ])('should still answer a real id complaint (%s)', (message, path, tool) => {
      expect(buildErrorHint('BAD_REQUEST', message, path)).toContain(tool);
    });
  });
});
