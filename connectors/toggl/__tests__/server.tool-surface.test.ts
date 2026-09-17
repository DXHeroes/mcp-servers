/**
 * Unit tests for TogglMcpServer — the advertised tool surface (listing, schemas, annotations)
 *
 * Split out of the original `server.test.ts`; shared setup lives in
 * `server.helpers.ts`. The `vi.mock` call below is deliberately repeated in
 * every split file, because module mocks are hoisted per module.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { TogglMcpServer } from '../src/server.js';
import { apiKeyConfig, mockCreateTimeEntry } from './server.helpers.js';

vi.mock('../src/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client.js')>();
  const { createTogglClientMock } = await import('./server.helpers.js');
  return createTogglClientMock(original);
});

describe('TogglMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  describe('listTools', () => {
    it('should return 37 tools', async () => {
      const server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();
      expect(tools).toHaveLength(37);
    });

    it('should have correct tool names', async () => {
      const server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();
      const names = tools.map((t) => t.name);

      // User & Workspace
      expect(names).toContain('toggl_me');
      expect(names).toContain('toggl_list_workspaces');
      expect(names).toContain('toggl_get_workspace');

      // Time Entries
      expect(names).toContain('toggl_list_time_entries');
      expect(names).toContain('toggl_get_current_time_entry');
      expect(names).toContain('toggl_create_time_entry');
      expect(names).toContain('toggl_update_time_entry');
      expect(names).toContain('toggl_stop_time_entry');
      expect(names).toContain('toggl_delete_time_entry');

      // Projects
      expect(names).toContain('toggl_list_projects');
      expect(names).toContain('toggl_get_project');
      expect(names).toContain('toggl_create_project');
      expect(names).toContain('toggl_update_project');

      // Project members
      expect(names).toContain('toggl_list_workspace_users');
      expect(names).toContain('toggl_list_project_users');
      expect(names).toContain('toggl_add_project_user');

      // Clients
      expect(names).toContain('toggl_list_clients');
      expect(names).toContain('toggl_create_client');
      expect(names).toContain('toggl_update_client');

      // Tags
      expect(names).toContain('toggl_list_tags');
      expect(names).toContain('toggl_create_tag');

      // Tasks
      expect(names).toContain('toggl_list_tasks');
      expect(names).toContain('toggl_get_task');
      expect(names).toContain('toggl_create_task');
      expect(names).toContain('toggl_update_task');
      expect(names).toContain('toggl_delete_task');

      // Completed CRUD
      expect(names).toContain('toggl_delete_project');
      expect(names).toContain('toggl_get_client');
      expect(names).toContain('toggl_archive_client');
      expect(names).toContain('toggl_restore_client');
      expect(names).toContain('toggl_delete_client');
      expect(names).toContain('toggl_update_tag');
      expect(names).toContain('toggl_delete_tag');

      // Reports
      expect(names).toContain('toggl_report_summary');
      expect(names).toContain('toggl_report_detailed');
      expect(names).toContain('toggl_report_weekly');
      expect(names).toContain('toggl_report_project_summary');
    });

    it('should have inputSchema on each tool', async () => {
      const server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
      }
    });

    it('should have description on each tool', async () => {
      const server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
      }
    });
  });

  // ── created_with is not a tool parameter  ──────────────
  describe('create time entry input schema', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should tolerate a caller still passing created_with, ignoring it', async () => {
      // Existing prompts may still send it; that must not become an input error.
      mockCreateTimeEntry.mockResolvedValue({ id: 100 });
      const result = (await server.callTool('toggl_create_time_entry', {
        workspace_id: 42,
        start: '2024-01-15T09:00:00Z',
        duration: 3600,
        created_with: 'some-old-prompt',
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      const args = mockCreateTimeEntry.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.created_with).toBeUndefined();
    });

    it('should not advertise created_with in the tool input schema', async () => {
      const tools = await server.listTools();
      const tool = tools.find((t) => t.name === 'toggl_create_time_entry');
      const inputSchema = tool?.inputSchema;
      const shape = (inputSchema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).not.toContain('created_with');
      expect(Object.keys(shape)).toContain('duration');
    });
  });

  // ── MCP annotations (the operator's only lever) ─────────────────────
  describe('tool annotations', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should annotate every tool, so none defaults into the write group', async () => {
      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toBeDefined();
        expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      }
    });

    it('should mark the read-only tools read-only', async () => {
      const tools = await server.listTools();
      const readOnly = [
        'toggl_me',
        'toggl_list_workspaces',
        'toggl_get_workspace',
        'toggl_list_time_entries',
        'toggl_get_current_time_entry',
        'toggl_list_projects',
        'toggl_get_project',
        'toggl_list_workspace_users',
        'toggl_list_project_users',
        'toggl_list_clients',
        'toggl_get_client',
        'toggl_list_tags',
        'toggl_list_tasks',
        'toggl_get_task',
        'toggl_report_summary',
        'toggl_report_detailed',
        'toggl_report_weekly',
        'toggl_report_project_summary',
      ];
      for (const name of readOnly) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.annotations?.readOnlyHint, name).toBe(true);
      }
      // The connector host classifies purely on readOnlyHint, so a write tool
      // claiming to be read-only would be waved through.
      const readOnlyCount = tools.filter((t) => t.annotations?.readOnlyHint === true).length;
      expect(readOnlyCount).toBe(readOnly.length);
      // The three annotation groups partition the tool set, so pinning all
      // three means a tool cannot change groups without a test saying so.
      const additiveWrites = tools.filter(
        (t) => t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false,
      );
      expect(additiveWrites.length).toBe(8);
      expect(readOnlyCount + additiveWrites.length).toBe(tools.length - 11);
    });

    it('should mark every delete tool destructive and not read-only', async () => {
      const tools = await server.listTools();
      const deletes = tools.filter((t) => t.name.includes('_delete_'));
      expect(deletes.length).toBe(5);
      for (const tool of deletes) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
        expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
      }
    });

    it('should not mark a purely additive write as destructive', async () => {
      const tools = await server.listTools();
      for (const name of [
        'toggl_create_project',
        'toggl_create_tag',
        'toggl_restore_client',
        'toggl_add_project_user',
      ]) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.annotations?.readOnlyHint, name).toBe(false);
        expect(tool?.annotations?.destructiveHint, name).toBe(false);
      }
    });

    it('should never mark a destructive tool read-only', async () => {
      const tools = await server.listTools();
      for (const tool of tools.filter((t) => t.annotations?.destructiveHint === true)) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      }
    });
  });
});
