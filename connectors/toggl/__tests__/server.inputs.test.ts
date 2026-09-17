/**
 * Unit tests for TogglMcpServer — input validation, enumerated values and empty upstream responses
 *
 * Split out of the original `server.test.ts`; shared setup lives in
 * `server.helpers.ts`. The `vi.mock` call below is deliberately repeated in
 * every split file, because module mocks are hoisted per module.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TogglMcpServer } from '../src/server.js';
import {
  apiKeyConfig,
  mockArchiveClient,
  mockDeleteClient,
  mockDeleteProject,
  mockDeleteTag,
  mockDeleteTask,
  mockDeleteTimeEntry,
  mockGetCurrentTimeEntry,
  mockListClients,
  mockListProjects,
  mockListTasks,
  mockReportSummary,
  mockRestoreClient,
  mockUpdateTimeEntry,
} from './server.helpers.js';

vi.mock('../src/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client.js')>();
  const { createTogglClientMock } = await import('./server.helpers.js');
  return createTogglClientMock(original);
});

describe('TogglMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  // ── Empty upstream responses still produce readable results ─────────
  describe('empty upstream responses', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    // Toggl answers DELETE (and archive/restore on some accounts) with an
    // empty 200 body, which the client returns as `undefined`. Serialising
    // that dropped the `text` key entirely: `{"content":[{"type":"text"}]}`.
    const emptyResponseTools: Array<[string, ReturnType<typeof vi.fn>, Record<string, unknown>]> = [
      ['toggl_delete_project', mockDeleteProject, { workspace_id: 42, project_id: 7 }],
      ['toggl_delete_client', mockDeleteClient, { workspace_id: 42, client_id: 3 }],
      ['toggl_delete_tag', mockDeleteTag, { workspace_id: 42, tag_id: 9 }],
      ['toggl_delete_task', mockDeleteTask, { workspace_id: 42, project_id: 7, task_id: 5 }],
      ['toggl_delete_time_entry', mockDeleteTimeEntry, { workspace_id: 42, time_entry_id: 100 }],
      ['toggl_archive_client', mockArchiveClient, { workspace_id: 42, client_id: 3 }],
      ['toggl_restore_client', mockRestoreClient, { workspace_id: 42, client_id: 3 }],
    ];

    it.each(emptyResponseTools)(
      '%s should return readable text when Toggl sends no body',
      async (tool, mock, args) => {
        mock.mockResolvedValue(undefined);
        const result = (await server.callTool(tool, args)) as {
          isError?: boolean;
          content: Array<{ type: string; text: string }>;
        };
        expect(result.isError, tool).toBeUndefined();
        expect(typeof result.content[0]?.text, tool).toBe('string');
        const data = JSON.parse(result.content[0]?.text ?? '');
        expect(data.success, tool).toBe(true);
        expect(data.tool, tool).toBe(tool);
      },
    );

    it('should not call an empty body a success for a read tool', async () => {
      // An empty 200 on a listing is not "no projects" — an empty result set
      // would come back as `[]`. Claiming success invites the model to report
      // an empty workspace it never saw.
      mockListProjects.mockResolvedValue(undefined);
      const result = (await server.callTool('toggl_list_projects', { workspace_id: 42 })) as {
        content: Array<{ text: string }>;
      };
      const data = JSON.parse(result.content[0]?.text ?? '');
      expect(data.success).toBe(false);
      expect(data.message).toMatch(/not mean there are no results/i);
    });

    it('should keep a null payload as null rather than calling it empty', async () => {
      // No timer running is a real answer, not an empty body.
      mockGetCurrentTimeEntry.mockResolvedValue(null);
      const result = (await server.callTool('toggl_get_current_time_entry', {})) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0]?.text).toBe('null');
    });
  });

  // ── Enumerated inputs  ──────────────────────────────────
  describe('enumerated inputs', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    async function call(tool: string, args: unknown) {
      return (await server.callTool(tool, args)) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
    }

    // `grouping`/`sub_grouping` are NOT enumerated here. Toggl's own API
    // definition types both as a free-form string and documents no allowed
    // set, while the Toggl UI groups summaries by tasks, tags and billable
    // status as well — an enum built from an unverifiable set would reject
    // requests Toggl accepts. Unsupported values come back as a 400 with a
    // hint instead.
    it.each(['tasks', 'tags'])(
      'should forward grouping %s rather than second-guessing Toggl',
      async (grouping) => {
        mockReportSummary.mockResolvedValue({ groups: [] });
        const result = await call('toggl_report_summary', {
          workspace_id: 1,
          start_date: '2024-01-01',
          end_date: '2024-01-31',
          grouping,
        });
        expect(result.isError).toBeUndefined();
        expect(mockReportSummary).toHaveBeenCalledWith(expect.objectContaining({ grouping }));
      },
    );

    it('should still reject an empty grouping', async () => {
      const result = await call('toggl_report_summary', {
        workspace_id: 1,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        grouping: '',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(String(result.content[0]?.text)).error).toBe('INVALID_INPUT');
      expect(mockReportSummary).not.toHaveBeenCalled();
    });

    it.each(['projects', 'users', 'clients'])('should accept grouping %s', async (grouping) => {
      mockReportSummary.mockResolvedValue({ groups: [] });
      const result = await call('toggl_report_summary', {
        workspace_id: 1,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        grouping,
      });
      expect(result.isError).toBeUndefined();
      expect(mockReportSummary).toHaveBeenCalledWith(expect.objectContaining({ grouping }));
    });

    it.each(['time_entries', 'users', 'clients', 'projects', 'tasks'])(
      'should accept sub_grouping %s',
      async (sub_grouping) => {
        mockReportSummary.mockResolvedValue({ groups: [] });
        const result = await call('toggl_report_summary', {
          workspace_id: 1,
          start_date: '2024-01-01',
          end_date: '2024-01-31',
          sub_grouping,
        });
        expect(result.isError).toBeUndefined();
      },
    );

    it('should forward a sub_grouping value the docs do not enumerate', async () => {
      mockReportSummary.mockResolvedValue({ groups: [] });
      const result = await call('toggl_report_summary', {
        workspace_id: 1,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        sub_grouping: 'tags',
      });
      expect(result.isError).toBeUndefined();
      expect(mockReportSummary).toHaveBeenCalledWith(
        expect.objectContaining({ sub_grouping: 'tags' }),
      );
    });

    it.each(['active', 'archived', 'both'])('should accept client status %s', async (status) => {
      mockListClients.mockResolvedValue([]);
      const result = await call('toggl_list_clients', { workspace_id: 1, status });
      expect(result.isError).toBeUndefined();
      expect(mockListClients).toHaveBeenCalledWith(expect.objectContaining({ status }));
    });

    it('should reject a client status Toggl does not accept', async () => {
      const result = await call('toggl_list_clients', { workspace_id: 1, status: 'inactive' });
      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_INPUT');
      expect(mockListClients).not.toHaveBeenCalled();
    });

    it('should still allow the enumerated fields to be omitted', async () => {
      mockListClients.mockResolvedValue([]);
      const result = await call('toggl_list_clients', { workspace_id: 1 });
      expect(result.isError).toBeUndefined();
    });
  });

  // ── Filters must not be dropped silently ────────────────────────────
  describe('toggl_list_tasks filters', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it.each(['search', 'page', 'per_page'])(
      'should reject %s combined with project_id instead of ignoring it',
      async (filter) => {
        const args: Record<string, unknown> = { workspace_id: 42, project_id: 7 };
        args[filter] = filter === 'search' ? 'onboarding' : 2;
        const result = (await server.callTool('toggl_list_tasks', args)) as {
          isError: boolean;
          content: Array<{ text: string }>;
        };
        expect(result.isError).toBe(true);
        const errorData = JSON.parse(result.content[0]?.text ?? '');
        expect(errorData.error).toBe('INVALID_INPUT');
        expect(errorData.details.some((d: { path: string }) => d.path === filter)).toBe(true);
        expect(mockListTasks).not.toHaveBeenCalled();
      },
    );

    it('should still allow the workspace-wide listing to search and page', async () => {
      mockListTasks.mockResolvedValue([]);
      const result = (await server.callTool('toggl_list_tasks', {
        workspace_id: 42,
        search: 'onboarding',
        page: 2,
        per_page: 100,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(mockListTasks).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'onboarding', page: 2, per_page: 100 }),
      );
    });

    it('should still allow project_id with active', async () => {
      mockListTasks.mockResolvedValue([]);
      const result = (await server.callTool('toggl_list_tasks', {
        workspace_id: 42,
        project_id: 7,
        active: true,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
    });
  });

  describe('identifier validation', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it.each([
      ['task_id', -7],
      ['project_id', 0],
    ])('should reject a non-positive %s on update', async (field, value) => {
      const result = (await server.callTool('toggl_update_time_entry', {
        workspace_id: 42,
        time_entry_id: 100,
        [field]: value,
      })) as { isError: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? '').error).toBe('INVALID_INPUT');
      expect(mockUpdateTimeEntry).not.toHaveBeenCalled();
    });

    it('should still accept null to unset those fields', async () => {
      mockUpdateTimeEntry.mockResolvedValue({ id: 100 });
      const result = (await server.callTool('toggl_update_time_entry', {
        workspace_id: 42,
        time_entry_id: 100,
        project_id: null,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
    });
  });
});
