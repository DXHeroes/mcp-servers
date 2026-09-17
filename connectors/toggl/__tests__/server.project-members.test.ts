/**
 * Unit tests for TogglMcpServer — workspace users, project members and project
 * privacy
 *
 * Shared setup lives in `server.helpers.ts`. The `vi.mock` call below is
 * deliberately repeated in every split file, because module mocks are hoisted
 * per module.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { TogglMcpServer } from '../src/server.js';
import {
  apiKeyConfig,
  mockAddProjectUser,
  mockCreateProject,
  mockListProjectUsers,
  mockListWorkspaceUsers,
} from './server.helpers.js';

vi.mock('../src/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client.js')>();
  const { createTogglClientMock } = await import('./server.helpers.js');
  return createTogglClientMock(original);
});

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

describe('TogglMcpServer', () => {
  let server: TogglMcpServer;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = new TogglMcpServer(apiKeyConfig);
    await server.initialize();
  });

  describe('callTool - project members', () => {
    it('should list workspace users', async () => {
      mockListWorkspaceUsers.mockResolvedValue([{ id: 7, fullname: 'Ada Example' }]);
      const result = (await server.callTool('toggl_list_workspace_users', {
        workspace_id: 42,
        exclude_deleted: true,
      })) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(mockListWorkspaceUsers).toHaveBeenCalledWith({
        workspace_id: 42,
        exclude_deleted: true,
      });
      expect(JSON.parse(String(result.content[0]?.text))[0].id).toBe(7);
    });

    it('should pass the project member filters through', async () => {
      mockListProjectUsers.mockResolvedValue([]);
      await server.callTool('toggl_list_project_users', {
        workspace_id: 42,
        project_ids: [10, 11],
        user_id: 7,
      });
      expect(mockListProjectUsers).toHaveBeenCalledWith({
        workspace_id: 42,
        project_ids: [10, 11],
        user_id: 7,
      });
    });

    it('should reject more project_ids than Toggl accepts', async () => {
      const project_ids = Array.from({ length: 201 }, (_, i) => i + 1);
      const result = (await server.callTool('toggl_list_project_users', {
        workspace_id: 42,
        project_ids,
      })) as ToolResult;
      expect(result.isError).toBe(true);
      expect(JSON.parse(String(result.content[0]?.text)).error).toBe('INVALID_INPUT');
      expect(mockListProjectUsers).not.toHaveBeenCalled();
    });

    it('should add a project user', async () => {
      mockAddProjectUser.mockResolvedValue({ id: 99, project_id: 10, user_id: 7, manager: false });
      const result = (await server.callTool('toggl_add_project_user', {
        workspace_id: 42,
        project_id: 10,
        user_id: 7,
      })) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(mockAddProjectUser).toHaveBeenCalledWith({
        workspace_id: 42,
        project_id: 10,
        user_id: 7,
      });
    });

    it('should require project_id and user_id to add a member', async () => {
      for (const args of [
        { workspace_id: 42, user_id: 7 },
        { workspace_id: 42, project_id: 10 },
      ]) {
        const result = (await server.callTool('toggl_add_project_user', args)) as ToolResult;
        expect(result.isError).toBe(true);
        expect(JSON.parse(String(result.content[0]?.text)).error).toBe('INVALID_INPUT');
      }
      expect(mockAddProjectUser).not.toHaveBeenCalled();
    });

    it('should not offer rates on the additive member tool', async () => {
      // A rate applied to all data rewrites what tracked time is worth, which
      // is not additive; the tool would have to be annotated destructive.
      const tools = await server.listTools();
      const inputSchema = tools.find((t) => t.name === 'toggl_add_project_user')?.inputSchema;
      const shape = (inputSchema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape).sort()).toEqual([
        'manager',
        'project_id',
        'user_id',
        'workspace_id',
      ]);
    });

    it('should forward is_private when creating a project', async () => {
      mockCreateProject.mockResolvedValue({ id: 10, is_private: true });
      await server.callTool('toggl_create_project', {
        workspace_id: 42,
        name: 'Client project',
        is_private: true,
      });
      expect(mockCreateProject).toHaveBeenCalledWith({
        workspace_id: 42,
        name: 'Client project',
        is_private: true,
      });
    });
  });
});
