/**
 * Unit tests for TogglClient — workspace users, project members and project
 * privacy.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { TogglApiError, TogglClient } from '../src/client.js';
import { mockFetch, mockResponse, setupTogglClientTest } from './client.helpers.js';

describe('TogglClient', () => {
  let client: TogglClient;

  setupTogglClientTest((c) => {
    client = c;
  });

  describe('listWorkspaceUsers', () => {
    it('should call GET /workspaces/{wid}/users', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listWorkspaceUsers({ workspace_id: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/users',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should pass exclude_deleted', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listWorkspaceUsers({ workspace_id: 42, exclude_deleted: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/users?exclude_deleted=true',
        expect.any(Object),
      );
    });

    it('should not return an api_token a user record carries', async () => {
      // Toggl does not document one on this model, but it does put api_token
      // on its other user models — the scrubber has to cover this one too.
      const TOKEN = 'fedcba9876543210fedcba9876543210';
      mockFetch.mockResolvedValue(
        mockResponse([{ id: 7, email: 'a@example.com', fullname: 'A', api_token: TOKEN }]),
      );
      const result = await client.listWorkspaceUsers({ workspace_id: 42 });
      expect(result).toEqual([
        { id: 7, email: 'a@example.com', fullname: 'A', api_token: '[REDACTED]' },
      ]);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
  });

  describe('listProjectUsers', () => {
    it('should call GET /workspaces/{wid}/project_users without filters', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listProjectUsers({ workspace_id: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/project_users',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should send project_ids as one comma-separated value', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listProjectUsers({
        workspace_id: 42,
        project_ids: [10, 11],
        user_id: 7,
        with_group_members: true,
      });
      const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
      expect(url.pathname).toBe('/api/v9/workspaces/42/project_users');
      expect(url.searchParams.get('project_ids')).toBe('10,11');
      expect(url.searchParams.getAll('project_ids')).toHaveLength(1);
      expect(url.searchParams.get('user_id')).toBe('7');
      expect(url.searchParams.get('with_group_members')).toBe('true');
    });
  });

  describe('addProjectUser', () => {
    it('should POST project_id, user_id and manager to /workspaces/{wid}/project_users', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 99, project_id: 10, user_id: 7 }));
      await client.addProjectUser({ workspace_id: 42, project_id: 10, user_id: 7, manager: true });
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/42/project_users');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ project_id: 10, user_id: 7, manager: true });
    });
  });

  describe('createProject', () => {
    it('should send is_private in the body', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 10 }));
      await client.createProject({ workspace_id: 42, name: 'Client project', is_private: true });
      const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({ name: 'Client project', is_private: true });
    });
  });

  describe('error hints', () => {
    async function captureError(message: string, call: () => Promise<unknown>) {
      mockFetch.mockResolvedValue(mockResponse(message, 400));
      try {
        await call();
      } catch (e) {
        return e as TogglApiError;
      }
      throw new Error('Should have thrown');
    }

    const addError = (message: string) =>
      captureError(message, () =>
        client.addProjectUser({ workspace_id: 42, project_id: 10, user_id: 7 }),
      );

    // Three of the four 400 messages Toggl documents for POST project_users.
    it('should not send the caller after a project_id when the member already exists', async () => {
      const error = await addError('Project user already exists');
      expect(error.hint).toContain('already a member');
      expect(error.hint).toContain('toggl_list_project_users');
      expect(error.hint).not.toContain('toggl_list_projects`');
    });

    it('should point at the workspace users for an invalid user_id', async () => {
      const error = await addError('Invalid user_id');
      expect(error.hint).toContain('toggl_list_workspace_users');
      expect(error.hint).toContain('invited');
    });

    it('should point at the projects for an invalid project_id', async () => {
      const error = await addError('Invalid project_id');
      expect(error.hint).toContain('toggl_list_projects');
    });

    it('should not give the membership hint for a user complaint elsewhere', async () => {
      const error = await captureError('Invalid user_id', () =>
        client.reportSummary({ workspace_id: 1, start_date: '2024-01-01', end_date: '2024-01-31' }),
      );
      expect(error.hint ?? '').not.toContain('toggl_list_workspace_users');
    });
  });
});
