/**
 * Unit tests for TogglMcpServer — task tools and the completed CRUD family
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
  mockCreateTask,
  mockCreateTimeEntry,
  mockDeleteClient,
  mockDeleteProject,
  mockDeleteTag,
  mockDeleteTask,
  mockGetClient,
  mockGetTask,
  mockListTasks,
  mockRestoreClient,
  mockUpdateTag,
  mockUpdateTask,
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
  // ── Tasks  ──────────────────────────────────────────────
  describe('callTool - task tools', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should list workspace tasks', async () => {
      mockListTasks.mockResolvedValue([{ id: 5, name: 'Onboarding' }]);
      const result = (await server.callTool('toggl_list_tasks', { workspace_id: 42 })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBeUndefined();
      expect(mockListTasks).toHaveBeenCalledWith({ workspace_id: 42 });
      expect(JSON.parse(String(result.content[0]?.text))[0].id).toBe(5);
    });

    it('should pass project_id through to the client', async () => {
      mockListTasks.mockResolvedValue([]);
      await server.callTool('toggl_list_tasks', { workspace_id: 42, project_id: 7 });
      expect(mockListTasks).toHaveBeenCalledWith({ workspace_id: 42, project_id: 7 });
    });

    it('should require workspace_id', async () => {
      const result = (await server.callTool('toggl_list_tasks', {})) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(JSON.parse(String(result.content[0]?.text)).error).toBe('INVALID_INPUT');
      expect(mockListTasks).not.toHaveBeenCalled();
    });

    it('should surface the paid-plan hint instead of a raw upstream error', async () => {
      const { TogglApiError } = await import('../src/client.js');
      mockListTasks.mockRejectedValue(
        new TogglApiError(
          'Forbidden',
          403,
          'FORBIDDEN',
          'Tasks are a paid Toggl Track feature (Starter plan or higher).',
        ),
      );
      const result = (await server.callTool('toggl_list_tasks', { workspace_id: 42 })) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('FORBIDDEN');
      expect(errorData.hint).toContain('paid');
    });

    it('should accept task_id when creating a time entry', async () => {
      mockCreateTimeEntry.mockResolvedValue({ id: 100 });
      const result = (await server.callTool('toggl_create_time_entry', {
        workspace_id: 42,
        project_id: 7,
        task_id: 5,
        start: '2024-01-15T09:00:00Z',
        duration: 3600,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(mockCreateTimeEntry).toHaveBeenCalledWith(expect.objectContaining({ task_id: 5 }));
    });

    it('should accept task_id: null when updating a time entry', async () => {
      mockUpdateTimeEntry.mockResolvedValue({ id: 100 });
      const result = (await server.callTool('toggl_update_time_entry', {
        workspace_id: 42,
        time_entry_id: 100,
        task_id: null,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(mockUpdateTimeEntry).toHaveBeenCalledWith(expect.objectContaining({ task_id: null }));
    });

    it('should reject task_id: null on create, where unsetting is meaningless', async () => {
      const result = (await server.callTool('toggl_create_time_entry', {
        workspace_id: 42,
        start: '2024-01-15T09:00:00Z',
        duration: 3600,
        task_id: null,
      })) as { isError: boolean };
      expect(result.isError).toBe(true);
    });

    it('should get a single task', async () => {
      mockGetTask.mockResolvedValue({ id: 5, name: 'Onboarding' });
      const result = (await server.callTool('toggl_get_task', {
        workspace_id: 42,
        project_id: 7,
        task_id: 5,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(mockGetTask).toHaveBeenCalledWith({ workspace_id: 42, project_id: 7, task_id: 5 });
    });

    it('should require project_id for toggl_get_task', async () => {
      const result = (await server.callTool('toggl_get_task', {
        workspace_id: 42,
        task_id: 5,
      })) as { isError: boolean };
      expect(result.isError).toBe(true);
      expect(mockGetTask).not.toHaveBeenCalled();
    });
  });

  // ── Completed CRUD  ─────────────────────────────────────
  describe('callTool - completed CRUD', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should delete a project', async () => {
      mockDeleteProject.mockResolvedValue(undefined);
      const result = (await server.callTool('toggl_delete_project', {
        workspace_id: 42,
        project_id: 7,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(mockDeleteProject).toHaveBeenCalledWith({ workspace_id: 42, project_id: 7 });
    });

    it('should pass teDeletionMode through', async () => {
      mockDeleteProject.mockResolvedValue(undefined);
      await server.callTool('toggl_delete_project', {
        workspace_id: 42,
        project_id: 7,
        teDeletionMode: 'unassign',
      });
      expect(mockDeleteProject).toHaveBeenCalledWith(
        expect.objectContaining({ teDeletionMode: 'unassign' }),
      );
    });

    it('should reject a teDeletionMode Toggl does not accept', async () => {
      const result = (await server.callTool('toggl_delete_project', {
        workspace_id: 42,
        project_id: 7,
        teDeletionMode: 'archive',
      })) as { isError: boolean };
      expect(result.isError).toBe(true);
      expect(mockDeleteProject).not.toHaveBeenCalled();
    });

    it('should get, archive, restore and delete a client', async () => {
      mockGetClient.mockResolvedValue({ id: 3 });
      mockArchiveClient.mockResolvedValue({ id: 3, archived: true });
      mockRestoreClient.mockResolvedValue({ id: 3, archived: false });
      mockDeleteClient.mockResolvedValue(undefined);
      const args = { workspace_id: 42, client_id: 3 };

      for (const tool of [
        'toggl_get_client',
        'toggl_archive_client',
        'toggl_restore_client',
        'toggl_delete_client',
      ]) {
        const result = (await server.callTool(tool, args)) as { isError?: boolean };
        expect(result.isError, tool).toBeUndefined();
      }
      expect(mockGetClient).toHaveBeenCalledWith(args);
      expect(mockArchiveClient).toHaveBeenCalledWith(args);
      expect(mockRestoreClient).toHaveBeenCalledWith(args);
      expect(mockDeleteClient).toHaveBeenCalledWith(args);
    });

    it('should require a name when renaming a tag', async () => {
      const result = (await server.callTool('toggl_update_tag', {
        workspace_id: 42,
        tag_id: 9,
      })) as { isError: boolean };
      expect(result.isError).toBe(true);
      expect(mockUpdateTag).not.toHaveBeenCalled();
    });

    it('should rename and delete a tag', async () => {
      mockUpdateTag.mockResolvedValue({ id: 9, name: 'renamed' });
      mockDeleteTag.mockResolvedValue(undefined);
      await server.callTool('toggl_update_tag', { workspace_id: 42, tag_id: 9, name: 'renamed' });
      await server.callTool('toggl_delete_tag', { workspace_id: 42, tag_id: 9 });
      expect(mockUpdateTag).toHaveBeenCalledWith({
        workspace_id: 42,
        tag_id: 9,
        name: 'renamed',
      });
      expect(mockDeleteTag).toHaveBeenCalledWith({ workspace_id: 42, tag_id: 9 });
    });

    it('should create, update and delete a task', async () => {
      mockCreateTask.mockResolvedValue({ id: 5 });
      mockUpdateTask.mockResolvedValue({ id: 5, active: false });
      mockDeleteTask.mockResolvedValue(undefined);

      await server.callTool('toggl_create_task', {
        workspace_id: 42,
        project_id: 7,
        name: 'Onboarding',
      });
      await server.callTool('toggl_update_task', {
        workspace_id: 42,
        project_id: 7,
        task_id: 5,
        active: false,
      });
      await server.callTool('toggl_delete_task', {
        workspace_id: 42,
        project_id: 7,
        task_id: 5,
      });

      expect(mockCreateTask).toHaveBeenCalledWith({
        workspace_id: 42,
        project_id: 7,
        name: 'Onboarding',
      });
      expect(mockUpdateTask).toHaveBeenCalledWith(
        expect.objectContaining({ task_id: 5, active: false }),
      );
      expect(mockDeleteTask).toHaveBeenCalledWith({ workspace_id: 42, project_id: 7, task_id: 5 });
    });

    it('should require project_id for every task write', async () => {
      for (const tool of ['toggl_create_task', 'toggl_update_task', 'toggl_delete_task']) {
        const result = (await server.callTool(tool, {
          workspace_id: 42,
          task_id: 5,
          name: 'X',
        })) as { isError: boolean };
        expect(result.isError, tool).toBe(true);
      }
    });

    // The convention is checked against the annotations, not against the tool
    // names: a destructive tool that is not called `toggl_delete_*` — an
    // overwrite, a workspace-wide rename — used to slip past a guard keyed on
    // `_delete_`, which is how the update family kept a "nothing is lost"
    // annotation while destroying values Toggl keeps no history of.
    it('should mark every destructive tool as destructive in its description', async () => {
      const tools = await server.listTools();
      const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
      // Pinned, not floored. A floor of 8 against an actual 11 would let three
      // tools quietly lose the annotation, which is the failure this whole
      // block exists to catch. The three groups partition the tool set:
      // 11 destructive + 7 additive writes + 16 read-only = 34.
      expect(destructive.length).toBe(11);
      for (const tool of destructive) {
        expect(tool.description, tool.name).toContain('DESTRUCTIVE');
      }
    });

    it('should annotate the writes that are not purely additive', async () => {
      // Per the MCP definition ("not purely additive"), not per the tool name.
      const tools = await server.listTools();
      for (const name of ['toggl_update_time_entry', 'toggl_update_tag', 'toggl_archive_client']) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.annotations?.destructiveHint, name).toBe(true);
      }
    });

    it('should annotate the whole update family, not a chosen few', async () => {
      // The WRITE_TOOL definition is "changes one in a way that loses
      // nothing". No update meets it: Toggl keeps no history of a project,
      // client, task, tag or time entry, so every overwrite makes the previous
      // value unknowable. Annotating only some of them was applying the
      // definition inconsistently, not applying a different one.
      const tools = await server.listTools();
      const updates = tools.filter((t) => t.name.includes('_update_'));
      expect(updates.length).toBe(5);
      for (const tool of updates) {
        expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
      }
    });

    it('should keep a destructive tool usable as the safer alternative it is', async () => {
      // The flag is one bit ("not purely additive"), not a ranking. Both of
      // these are destructive *and* what the delete descriptions point at, so
      // their own descriptions have to say why they are still the safer move —
      // otherwise the model reads DESTRUCTIVE as a reason to avoid them and
      // reaches for the delete instead.
      const tools = await server.listTools();
      for (const name of ['toggl_update_client', 'toggl_archive_client']) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.annotations?.destructiveHint, name).toBe(true);
        expect(tool?.description, name).toMatch(/safer|do not fall back|reverse it with/i);
      }
    });

    it('should name a recoverable alternative in every delete description', async () => {
      // Not a *non-destructive* alternative, which is what this used to claim:
      // every candidate it accepts (`_update_*`, `_archive_*`) is annotated
      // destructive by this package's own definition. What the delete has to
      // name is the tool that reaches the same intent while leaving the record
      // in place — `active: false` instead of removing a project, archiving a
      // client instead of deleting it, correcting a time entry instead of
      // dropping it. For `toggl_delete_time_entry` that alternative is
      // `toggl_update_time_entry`, which is a destructive correction rather
      // than a reversal; it is still the one that keeps the tracked time.
      const tools = await server.listTools();
      const deletes = tools.filter((t) => t.name.includes('_delete_'));
      expect(deletes.length).toBe(5);
      for (const tool of deletes) {
        const alternatives = tools
          .map((t) => t.name)
          .filter((name) => name.includes('_update_') || name.includes('_archive_'));
        expect(
          alternatives.some((alternative) => tool.description?.includes(alternative)),
          `${tool.name} names no non-destructive alternative`,
        ).toBe(true);
      }
    });

    it('should say what the change costs, not just that it changes something', async () => {
      const tools = await server.listTools();
      for (const tool of tools.filter((t) => t.annotations?.destructiveHint === true)) {
        expect(tool.description, tool.name).toMatch(
          /no undo|irreversible|permanently|unknowable|not symmetric/i,
        );
      }
    });
  });

  describe('toggl_restore_client', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should pass restore_all_projects through so archiving can be undone', async () => {
      mockRestoreClient.mockResolvedValue({ id: 3 });
      const result = (await server.callTool('toggl_restore_client', {
        workspace_id: 42,
        client_id: 3,
        restore_all_projects: true,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(mockRestoreClient).toHaveBeenCalledWith({
        workspace_id: 42,
        client_id: 3,
        restore_all_projects: true,
      });
    });

    it('should mention the paid plan and the project scope when archiving', async () => {
      const tools = await server.listTools();
      const archive = tools.find((t) => t.name === 'toggl_archive_client');
      // Toggl documents this endpoint as archiving the client AND its related
      // projects, on paid plans only. Both facts change what the model does.
      expect(archive?.description).toMatch(/paid/i);
      expect(archive?.description).toMatch(/projects/i);
      expect(archive?.description).toContain('restore_all_projects');
    });
  });
});
