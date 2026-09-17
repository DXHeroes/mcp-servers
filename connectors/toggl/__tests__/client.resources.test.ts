/**
 * Unit tests for TogglClient — project, client, tag and task endpoints.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { TogglClient } from '../src/client.js';
import {
  mockFetch,
  mockResponse,
  setupTogglClientTest,
  syntheticHexToken,
} from './client.helpers.js';

describe('TogglClient', () => {
  let client: TogglClient;

  setupTogglClientTest((c) => {
    client = c;
  });

  // ── Projects ────────────────────────────────────────────────────────

  describe('listProjects', () => {
    it('should call GET /workspaces/{wid}/projects with a default page size', async () => {
      // Toggl paginates the endpoint but defaults to no limit, so an
      // unparameterised call returned every project in the workspace.
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listProjects({ workspace_id: 42 });
      const url = String(mockFetch.mock.calls[0]?.[0]);
      expect(url).toContain('https://api.track.toggl.com/api/v9/workspaces/42/projects?');
      expect(url).toContain('per_page=50');
      expect(url).toContain('page=1');
    });

    it('should pass active and pagination params', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listProjects({ workspace_id: 42, active: true, page: 2, per_page: 50 });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('active=true'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('page=2'), expect.any(Object));
    });
  });

  describe('getProject', () => {
    it('should call GET /workspaces/{wid}/projects/{id}', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 10, name: 'Project' }));
      await client.getProject({ workspace_id: 42, project_id: 10 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/10',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('createProject', () => {
    it('should POST to /workspaces/{wid}/projects', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 10 }));
      await client.createProject({ workspace_id: 42, name: 'New Project' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"name":"New Project"'),
        }),
      );
    });
  });

  describe('updateProject', () => {
    it('should PUT to /workspaces/{wid}/projects/{id}', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 10 }));
      await client.updateProject({ workspace_id: 42, project_id: 10, name: 'Renamed' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/10',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"name":"Renamed"'),
        }),
      );
    });
  });

  // ── Clients ─────────────────────────────────────────────────────────

  describe('listClients', () => {
    it('should call GET /workspaces/{wid}/clients', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listClients({ workspace_id: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/clients',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should pass status and name params', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listClients({ workspace_id: 42, status: 'active', name: 'Acme' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('status=active'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('name=Acme'),
        expect.any(Object),
      );
    });
  });

  describe('createClient', () => {
    it('should POST to /workspaces/{wid}/clients', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 5 }));
      await client.createClient({ workspace_id: 42, name: 'Acme Corp' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/clients',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"name":"Acme Corp"'),
        }),
      );
    });
  });

  describe('updateClient', () => {
    it('should PUT to /workspaces/{wid}/clients/{id}', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 5 }));
      await client.updateClient({ workspace_id: 42, client_id: 5, name: 'Acme Inc' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/clients/5',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"name":"Acme Inc"'),
        }),
      );
    });
  });

  // ── Tags ────────────────────────────────────────────────────────────

  describe('listTags', () => {
    it('should call GET /workspaces/{wid}/tags', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listTags({ workspace_id: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/tags',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('createTag', () => {
    it('should POST to /workspaces/{wid}/tags', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 1, name: 'urgent' }));
      await client.createTag({ workspace_id: 42, name: 'urgent' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/tags',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"name":"urgent"'),
        }),
      );
    });
  });

  // ── Completed CRUD  ──────────────────────────────────────

  // These tests verify how the request URL is composed. They cannot verify
  // that Toggl honours `teDeletionMode`: the parameter is documented in
  // Toggl's API definition as "Time entries deletion mode: 'delete' or
  // 'unassign'", its behaviour when omitted is documented nowhere, and this
  // suite talks to a mock, not to Toggl.
  describe('deleteProject', () => {
    it('should default to unassign rather than leaving the mode to Toggl', async () => {
      mockFetch.mockResolvedValue(mockResponse(undefined));
      await client.deleteProject({ workspace_id: 42, project_id: 7 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7?teDeletionMode=unassign',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('should pass unassign through', async () => {
      mockFetch.mockResolvedValue(mockResponse(undefined));
      await client.deleteProject({ workspace_id: 42, project_id: 7, teDeletionMode: 'unassign' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7?teDeletionMode=unassign',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('should only ask for delete when the caller says so explicitly', async () => {
      mockFetch.mockResolvedValue(mockResponse(undefined));
      await client.deleteProject({ workspace_id: 42, project_id: 7, teDeletionMode: 'delete' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7?teDeletionMode=delete',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('client CRUD', () => {
    it('should GET a single client', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 3 }));
      await client.getClient({ workspace_id: 42, client_id: 3 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/clients/3',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should DELETE a client', async () => {
      mockFetch.mockResolvedValue(mockResponse(undefined));
      await client.deleteClient({ workspace_id: 42, client_id: 3 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/clients/3',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('should POST to archive a client', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 3, archived: true }));
      await client.archiveClient({ workspace_id: 42, client_id: 3 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/clients/3/archive',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should POST to restore a client without a body by default', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 3, archived: false }));
      await client.restoreClient({ workspace_id: 42, client_id: 3 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/clients/3/restore',
        expect.objectContaining({ method: 'POST' }),
      );
      const init = mockFetch.mock.calls[0]?.[1];
      expect((init as { body?: string }).body).toBeUndefined();
    });

    it('should send restore_all_projects when the caller asks to undo the archive', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 3, archived: false }));
      await client.restoreClient({ workspace_id: 42, client_id: 3, restore_all_projects: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/clients/3/restore',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ restore_all_projects: true }),
        }),
      );
    });
  });

  describe('tag CRUD', () => {
    it('should PUT the new tag name', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 9, name: 'renamed' }));
      await client.updateTag({ workspace_id: 42, tag_id: 9, name: 'renamed' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/tags/9',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ name: 'renamed' }),
        }),
      );
    });

    it('should DELETE a tag', async () => {
      mockFetch.mockResolvedValue(mockResponse(undefined));
      await client.deleteTag({ workspace_id: 42, tag_id: 9 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/tags/9',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('task CRUD', () => {
    it('should POST a new task to the project endpoint', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 5 }));
      await client.createTask({
        workspace_id: 42,
        project_id: 7,
        name: 'Onboarding',
        estimated_seconds: 7200,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7/tasks',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Onboarding', estimated_seconds: 7200 }),
        }),
      );
    });

    it('should not send workspace_id or project_id in the task body', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 5 }));
      await client.createTask({ workspace_id: 42, project_id: 7, name: 'X' });
      const init = mockFetch.mock.calls[0]?.[1];
      const body = JSON.parse((init as { body: string }).body);
      expect(body).toEqual({ name: 'X' });
    });

    it('should PUT a task update', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 5 }));
      await client.updateTask({ workspace_id: 42, project_id: 7, task_id: 5, active: false });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7/tasks/5',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ active: false }) }),
      );
    });

    it('should DELETE a task', async () => {
      mockFetch.mockResolvedValue(mockResponse(undefined));
      await client.deleteTask({ workspace_id: 42, project_id: 7, task_id: 5 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7/tasks/5',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  // ── Tasks  ──────────────────────────────────────────────

  describe('listTasks', () => {
    it('should call the workspace-wide endpoint when no project_id is given', async () => {
      mockFetch.mockResolvedValue(mockResponse([{ id: 5, name: 'Task' }]));
      await client.listTasks({ workspace_id: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/tasks',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should call the project-scoped endpoint when project_id is given', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listTasks({ workspace_id: 42, project_id: 7 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7/tasks',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should pass search and pagination on the workspace-wide endpoint', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listTasks({
        workspace_id: 42,
        active: true,
        search: 'onboarding',
        page: 2,
        per_page: 100,
      });
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('active=true');
      expect(url).toContain('search=onboarding');
      expect(url).toContain('page=2');
      expect(url).toContain('per_page=100');
    });

    it('should send active but not paging on the project-scoped endpoint', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listTasks({
        workspace_id: 42,
        project_id: 7,
        active: true,
        page: 3,
        per_page: 50,
      });
      const url = String(mockFetch.mock.calls[0]?.[0]);
      expect(url).toBe(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7/tasks?active=true',
      );
    });

    it('should not smuggle search or paging onto the project-scoped endpoint', async () => {
      // `ListTasksSchema` rejects that combination, so a caller can only reach
      // this through the client directly — the URL must still stay clean.
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.listTasks({ workspace_id: 42, project_id: 7, search: 'onboarding' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7/tasks',
        expect.any(Object),
      );
    });
  });

  describe('secret redaction on the endpoints added for CRUD', () => {
    const TOKEN = syntheticHexToken('c');

    it('should strip credentials from a single client payload', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          id: 3,
          name: 'Acme',
          api_token: TOKEN,
          ical_url: '/ical/workspace_user/synthetic-calendar-secret',
        }),
      );
      const result = await client.getClient({ workspace_id: 42, client_id: 3 });
      expect(result).toEqual({
        id: 3,
        name: 'Acme',
        api_token: '[REDACTED]',
        ical_url: '[REDACTED]',
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain('abc123def456');
    });

    it('should strip credentials from a task payload', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 5, name: 'Onboarding', api_token: TOKEN }));
      const result = await client.getTask({ workspace_id: 42, project_id: 7, task_id: 5 });
      expect(result).toEqual({ id: 5, name: 'Onboarding', api_token: '[REDACTED]' });
    });

    it('should strip credentials from a task listing', async () => {
      mockFetch.mockResolvedValue(
        mockResponse([{ id: 5, name: 'Onboarding', workspace: { id: 42, api_token: TOKEN } }]),
      );
      const result = await client.listTasks({ workspace_id: 42 });
      expect(result).toEqual([
        { id: 5, name: 'Onboarding', workspace: { id: 42, api_token: '[REDACTED]' } },
      ]);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
  });

  describe('getTask', () => {
    it('should call GET on the project-scoped task', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 5 }));
      await client.getTask({ workspace_id: 42, project_id: 7, task_id: 5 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42/projects/7/tasks/5',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });
});
