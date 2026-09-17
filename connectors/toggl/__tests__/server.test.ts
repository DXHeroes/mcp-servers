/**
 * Unit tests for TogglMcpServer — core behaviour, single-tool calls and error mapping
 *
 * Split out of the original `server.test.ts`; shared setup lives in
 * `server.helpers.ts`. The `vi.mock` call below is deliberately repeated in
 * every split file, because module mocks are hoisted per module.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TogglMcpServer } from '../src/server.js';
import {
  apiKeyConfig,
  mockCreateTimeEntry,
  mockGetWorkspace,
  mockListProjects,
  mockMe,
  mockReportSummary,
  mockValidateApiKey,
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
  describe('initialize', () => {
    it('should initialize with valid API key', async () => {
      const server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();

      mockMe.mockResolvedValue({ id: 1 });
      const result = (await server.callTool('toggl_me', {})) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
    });

    it('should set error when no API key is provided', async () => {
      const server = new TogglMcpServer(null);
      await server.initialize();

      const result = (await server.callTool('toggl_me', {})) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('API_KEY_REQUIRED');
    });

    it('should set error when API key is empty', async () => {
      const server = new TogglMcpServer({ ...apiKeyConfig, apiKey: '' });
      await server.initialize();

      const result = (await server.callTool('toggl_me', {})) as { isError: boolean };
      expect(result.isError).toBe(true);
    });
  });

  describe('validate', () => {
    it('should delegate to TogglClient.validateApiKey', async () => {
      const server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();

      mockValidateApiKey.mockResolvedValue({ valid: true });
      const result = await server.validate();
      expect(result).toEqual({ valid: true });
    });

    it('should return invalid when no API key configured', async () => {
      const server = new TogglMcpServer(null);
      await server.initialize();

      const result = await server.validate();
      expect(result).toEqual({ valid: false, error: 'API token not configured' });
    });
  });

  describe('callTool - toggl_me', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should return user data on success', async () => {
      mockMe.mockResolvedValue({ id: 1, email: 'test@test.com' });

      const result = (await server.callTool('toggl_me', {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0]?.type).toBe('text');
      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.id).toBe(1);
    });
  });

  describe('callTool - toggl_create_time_entry', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should create time entry', async () => {
      mockCreateTimeEntry.mockResolvedValue({ id: 100, description: 'Working' });

      const result = (await server.callTool('toggl_create_time_entry', {
        workspace_id: 42,
        description: 'Working',
        start: '2024-01-01T09:00:00Z',
        duration: 3600,
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.id).toBe(100);
    });

    it('should return error for invalid input', async () => {
      const result = (await server.callTool('toggl_create_time_entry', {})) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_INPUT');
    });
  });

  describe('callTool - toggl_report_summary', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should return summary report', async () => {
      mockReportSummary.mockResolvedValue({ groups: [{ id: 1 }] });

      const result = (await server.callTool('toggl_report_summary', {
        workspace_id: 42,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.groups).toHaveLength(1);
    });
  });

  describe('callTool - toggl_list_projects', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should list projects', async () => {
      mockListProjects.mockResolvedValue([{ id: 1, name: 'Project A' }]);

      const result = (await server.callTool('toggl_list_projects', {
        workspace_id: 42,
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data).toHaveLength(1);
    });
  });

  describe('callTool - unknown tool', () => {
    it('should return error for unknown tool name', async () => {
      const server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();

      const result = (await server.callTool('unknown_tool', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('UNKNOWN_TOOL');
    });
  });

  describe('callTool - API error handling', () => {
    let server: TogglMcpServer;

    beforeEach(async () => {
      server = new TogglMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should not repeat the error code inside the message ', async () => {
      const { TogglApiError } = await import('../src/client.js');
      mockMe.mockRejectedValue(new TogglApiError('start: invalid date', 400, 'BAD_REQUEST'));

      const result = (await server.callTool('toggl_me', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData).toEqual({ error: 'BAD_REQUEST', message: 'start: invalid date' });
      expect(errorData.message).not.toContain('BAD_REQUEST');
    });

    it('should surface the remediation hint as its own field ', async () => {
      const { TogglApiError } = await import('../src/client.js');
      mockMe.mockRejectedValue(
        new TogglApiError('Task not found', 400, 'BAD_REQUEST', 'Use `toggl_list_tasks`.'),
      );

      const result = (await server.callTool('toggl_me', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.message).toBe('Task not found');
      expect(errorData.hint).toBe('Use `toggl_list_tasks`.');
    });

    it('should omit the hint field when there is no hint', async () => {
      const { TogglApiError } = await import('../src/client.js');
      mockMe.mockRejectedValue(new TogglApiError('boom', 500, 'API_ERROR'));

      const result = (await server.callTool('toggl_me', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      const errorData = JSON.parse(String(result.content[0]?.text));
      expect('hint' in errorData).toBe(false);
    });

    it('should handle TogglApiError with INVALID_API_KEY code', async () => {
      const { TogglApiError } = await import('../src/client.js');
      mockMe.mockRejectedValue(new TogglApiError('Unauthorized', 401, 'INVALID_API_KEY'));

      const result = (await server.callTool('toggl_me', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_API_KEY');
    });

    it('should handle TogglApiError with RATE_LIMITED code', async () => {
      const { TogglApiError } = await import('../src/client.js');
      mockMe.mockRejectedValue(new TogglApiError('Too many', 429, 'RATE_LIMITED'));

      const result = (await server.callTool('toggl_me', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('RATE_LIMITED');
    });

    it('should handle TogglApiError with NOT_FOUND code', async () => {
      const { TogglApiError } = await import('../src/client.js');
      mockGetWorkspace.mockRejectedValue(new TogglApiError('Not found', 404, 'NOT_FOUND'));

      const result = (await server.callTool('toggl_get_workspace', {
        workspace_id: 999,
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('NOT_FOUND');
    });

    it('should handle generic errors', async () => {
      mockMe.mockRejectedValue(new Error('Network error'));

      const result = (await server.callTool('toggl_me', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('API_ERROR');
    });
  });

  describe('listResources', () => {
    it('should return empty array', async () => {
      const server = new TogglMcpServer(apiKeyConfig);
      const resources = await server.listResources();
      expect(resources).toEqual([]);
    });
  });
});
