/**
 * Unit tests for TogglClient — time entry endpoints.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { TogglClient } from '../src/client.js';
import { mockFetch, mockResponse, setupTogglClientTest } from './client.helpers.js';

describe('TogglClient', () => {
  let client: TogglClient;

  setupTogglClientTest((c) => {
    client = c;
  });

  describe('listTimeEntries', () => {
    it('should call GET /me/time_entries asking for meta entities', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listTimeEntries({});
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/me/time_entries?meta=true',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should pass date params', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listTimeEntries({ start_date: '2024-01-01', end_date: '2024-01-31' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/me/time_entries?start_date=2024-01-01&end_date=2024-01-31&meta=true',
        expect.any(Object),
      );
    });

    it('should always ask for meta, so names never cost a second request', async () => {
      // The point of the parameter: without it every entry is ids only, and
      // resolving them means a second call to an endpoint Toggl throttles
      // hard. It is not optional because no caller wants the ids alone.
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listTimeEntries({ start_date: '2024-01-01' });
      expect(String(mockFetch.mock.calls[0]?.[0])).toContain('meta=true');
    });
  });

  describe('getCurrentTimeEntry meta', () => {
    it('should not send meta on the running-timer endpoint', async () => {
      // Two independent mirrors of Toggl's API definition list no query
      // parameters at all here. Sending an unverified one and describing the
      // names as available would be a promise Toggl has not made.
      mockFetch.mockResolvedValue(mockResponse(null));
      await client.getCurrentTimeEntry();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/me/time_entries/current',
        expect.any(Object),
      );
    });
  });

  describe('getCurrentTimeEntry', () => {
    it('should call GET /me/time_entries/current', async () => {
      mockFetch.mockResolvedValue(mockResponse(null));
      await client.getCurrentTimeEntry();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/me/time_entries/current',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('createTimeEntry', () => {
    it('should POST to /workspaces/{wid}/time_entries', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 1 }));
      await client.createTimeEntry({
        workspace_id: 42,
        description: 'Test',
        start: '2024-01-01T09:00:00Z',
        duration: 3600,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/time_entries',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"description":"Test"'),
        }),
      );
    });
  });

  describe('updateTimeEntry', () => {
    it('should PUT to /workspaces/{wid}/time_entries/{id}', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 99 }));
      await client.updateTimeEntry({
        workspace_id: 42,
        time_entry_id: 99,
        description: 'Updated',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/time_entries/99',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"description":"Updated"'),
        }),
      );
    });
  });

  describe('stopTimeEntry', () => {
    it('should PATCH to /workspaces/{wid}/time_entries/{id}/stop', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 99 }));
      await client.stopTimeEntry({ workspace_id: 42, time_entry_id: 99 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/time_entries/99/stop',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  describe('deleteTimeEntry', () => {
    it('should DELETE /workspaces/{wid}/time_entries/{id}', async () => {
      mockFetch.mockResolvedValue(mockResponse(undefined, 200));
      await client.deleteTimeEntry({ workspace_id: 42, time_entry_id: 99 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/time_entries/99',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('time entry task_id', () => {
    it('should send task_id when creating a time entry', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 1 }));
      await client.createTimeEntry({
        workspace_id: 42,
        project_id: 7,
        task_id: 5,
        start: '2024-01-15T09:00:00Z',
        duration: 3600,
      });
      const init = mockFetch.mock.calls[0]?.[1];
      const body = JSON.parse((init as { body: string }).body);
      expect(body.task_id).toBe(5);
    });

    it('should send task_id: null when unsetting it on update', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 1 }));
      await client.updateTimeEntry({ workspace_id: 42, time_entry_id: 1, task_id: null });
      const init = mockFetch.mock.calls[0]?.[1];
      const body = JSON.parse((init as { body: string }).body);
      expect(body.task_id).toBeNull();
    });
  });

  // ── created_with is set by the client, not the caller  ──

  describe('created_with', () => {
    it('should stamp created_with on every created time entry', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 1 }));
      await client.createTimeEntry({
        workspace_id: 42,
        start: '2024-01-15T09:00:00Z',
        duration: 3600,
      });
      const init = mockFetch.mock.calls[0]?.[1];
      const body = JSON.parse((init as { body: string }).body);
      expect(body.created_with).toBe('mcp-toggl');
    });
  });
});
