/**
 * Unit tests for GeminiDeepResearchMcpServer
 */

import type { ApiKeyConfig } from '@dxheroes/mcp-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyGeminiError } from '../src/errors.js';
import type { DeepResearchResult } from '../src/gemini-client.js';
import { GeminiDeepResearchMcpServer } from '../src/server.js';

// Mock the GeminiClient
const mockValidateApiKey = vi.fn();
const mockDeepResearch = vi.fn();
const mockFollowUp = vi.fn();

vi.mock('../src/gemini-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/gemini-client.js')>();
  return {
    ...original,
    GeminiClient: class MockGeminiClient {
      validateApiKey = mockValidateApiKey;
      deepResearch = mockDeepResearch;
      followUp = mockFollowUp;
    },
  };
});

describe('GeminiDeepResearchMcpServer', () => {
  const apiKeyConfig: ApiKeyConfig = {
    apiKey: 'test-key-123',
    headerName: 'x-goog-api-key',
    headerValue: 'test-key-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize with valid API key', async () => {
      const server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();

      // Should be able to call tools without API_KEY_REQUIRED error
      mockDeepResearch.mockResolvedValue({
        content: 'result',
        interactionId: 'id',
        status: 'completed',
      });
      const result = (await server.callTool('deep_research', {
        topic: 'test',
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
    });

    it('should set error when no API key is provided', async () => {
      const server = new GeminiDeepResearchMcpServer(null);
      await server.initialize();

      const result = (await server.callTool('deep_research', { topic: 'test' })) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('API_KEY_REQUIRED');
    });

    it('should set error when API key is empty', async () => {
      const server = new GeminiDeepResearchMcpServer({
        ...apiKeyConfig,
        apiKey: '',
      });
      await server.initialize();

      const result = (await server.callTool('deep_research', { topic: 'test' })) as {
        isError: boolean;
      };
      expect(result.isError).toBe(true);
    });
  });

  describe('validate', () => {
    it('should delegate to GeminiClient.validateApiKey', async () => {
      const server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();

      mockValidateApiKey.mockResolvedValue({ valid: true });

      const result = await server.validate();
      expect(result).toEqual({ valid: true });
    });

    it('should return invalid when no API key configured', async () => {
      const server = new GeminiDeepResearchMcpServer(null);
      await server.initialize();

      const result = await server.validate();
      expect(result).toEqual({ valid: false, error: 'API key not configured' });
    });
  });

  describe('listTools', () => {
    it('should return deep_research and deep_research_followup tools', async () => {
      const server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0]?.name).toBe('deep_research');
      expect(tools[1]?.name).toBe('deep_research_followup');
    });

    it('should have inputSchema on each tool', async () => {
      const server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();

      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  describe('callTool - deep_research', () => {
    let server: GeminiDeepResearchMcpServer;

    beforeEach(async () => {
      server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should return research content on success', async () => {
      const mockResult: DeepResearchResult = {
        content: 'Research findings about AI',
        interactionId: 'interaction-123',
        citations: ['https://source.com'],
        status: 'completed',
      };
      mockDeepResearch.mockResolvedValue(mockResult);

      const result = (await server.callTool('deep_research', {
        topic: 'AI trends',
      })) as { content: Array<{ type: string; text: string }>; metadata: unknown };

      expect(result.content[0]?.text).toBe('Research findings about AI');
      expect(result.metadata).toEqual(
        expect.objectContaining({
          interactionId: 'interaction-123',
          citations: ['https://source.com'],
        }),
      );
    });

    it('should return error for invalid input', async () => {
      const result = (await server.callTool('deep_research', {})) as { isError: boolean };
      expect(result.isError).toBe(true);
    });

    it('should return error for empty topic', async () => {
      const result = (await server.callTool('deep_research', { topic: '' })) as {
        isError: boolean;
      };
      expect(result.isError).toBe(true);
    });

    it('should return error when research fails', async () => {
      const mockResult: DeepResearchResult = {
        content: '',
        interactionId: 'interaction-123',
        status: 'failed',
        error: 'Research failed',
      };
      mockDeepResearch.mockResolvedValue(mockResult);

      const result = (await server.callTool('deep_research', {
        topic: 'test topic',
      })) as { isError: boolean };

      expect(result.isError).toBe(true);
    });

    it('should handle 401 API errors', async () => {
      mockDeepResearch.mockRejectedValue(new Error('401 Unauthorized'));

      const result = (await server.callTool('deep_research', {
        topic: 'test topic',
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_API_KEY');
    });

    it('should handle 429 rate limit errors', async () => {
      mockDeepResearch.mockRejectedValue(new Error('429 Too Many Requests'));

      const result = (await server.callTool('deep_research', {
        topic: 'test topic',
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('RATE_LIMITED');
    });

    it('should handle timeout errors', async () => {
      mockDeepResearch.mockRejectedValue(new Error('Research Timeout after 60 minutes'));

      const result = (await server.callTool('deep_research', {
        topic: 'test topic',
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('TIMEOUT');
    });
  });

  describe('callTool - deep_research_followup', () => {
    let server: GeminiDeepResearchMcpServer;

    beforeEach(async () => {
      server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should return follow-up content on success', async () => {
      const mockResult: DeepResearchResult = {
        content: 'Follow-up answer',
        interactionId: 'followup-123',
        status: 'completed',
      };
      mockFollowUp.mockResolvedValue(mockResult);

      const result = (await server.callTool('deep_research_followup', {
        interactionId: 'prev-id',
        question: 'What about X?',
      })) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0]?.text).toBe('Follow-up answer');
    });

    it('should return error for missing interactionId', async () => {
      const result = (await server.callTool('deep_research_followup', {
        question: 'What about X?',
      })) as { isError: boolean };

      expect(result.isError).toBe(true);
    });

    it('should return error for missing question', async () => {
      const result = (await server.callTool('deep_research_followup', {
        interactionId: 'prev-id',
      })) as { isError: boolean };

      expect(result.isError).toBe(true);
    });
  });

  describe('callTool - unknown tool', () => {
    it('should return error for unknown tool name', async () => {
      const server = new GeminiDeepResearchMcpServer(apiKeyConfig);
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

  // ── MCP annotations (the operator's only lever) ─────────────────────

  describe('tool annotations', () => {
    let server: GeminiDeepResearchMcpServer;

    beforeEach(async () => {
      server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should annotate every tool, so none defaults into the write group', async () => {
      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toBeDefined();
        expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      }
    });

    it('should mark both tools read-only', async () => {
      // Pinned, not floored. A floor of 1 against an actual 2 would let a tool
      // quietly lose its annotation, which is the failure this block exists
      // to catch. The package has no write surface at all: it asks Gemini
      // questions and returns prose.
      const tools = await server.listTools();
      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
      expect(readOnly.map((t) => t.name)).toEqual(['deep_research', 'deep_research_followup']);
      expect(readOnly.length).toBe(tools.length);
      expect(tools.length).toBe(2);
    });

    it('should not mark any tool destructive', async () => {
      // Nothing here deletes or overwrites anything. A future tool that does
      // has to change this test on its way in, which is the point.
      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      }
      expect(tools.filter((t) => t.annotations?.destructiveHint === true).length).toBe(0);
    });

    it('should not claim a repeated research call is idempotent', async () => {
      // Calling deep_research twice starts a second background task and, per
      // the tool's own description, costs another ~$2-5.
      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.annotations?.idempotentHint, tool.name).toBe(false);
        expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
      }
    });
  });

  // ── The content block must always carry usable text ─────────────────

  describe('content block text', () => {
    let server: GeminiDeepResearchMcpServer;

    beforeEach(async () => {
      server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();
    });

    it('should send a string for deep_research even when the SDK yields no content', async () => {
      // `text: result.content` used to be passed straight through. A degenerate
      // SDK answer put `undefined` on the wire, and a content block with no
      // text reads to a model exactly like "nothing to report".
      mockDeepResearch.mockResolvedValue({
        content: undefined,
        interactionId: 'interaction-9',
        status: 'completed',
      } as unknown as DeepResearchResult);

      const result = (await server.callTool('deep_research', { topic: 'x' })) as {
        content: Array<{ text: unknown }>;
        isError?: boolean;
      };

      expect(typeof result.content[0]?.text).toBe('string');
      expect(String(result.content[0]?.text).length).toBeGreaterThan(0);
      expect(String(result.content[0]?.text)).toContain('interaction-9');
    });

    it('should not let an empty report read as "no findings"', async () => {
      mockDeepResearch.mockResolvedValue({
        content: '   ',
        interactionId: 'interaction-10',
        status: 'completed',
      });

      const result = (await server.callTool('deep_research', { topic: 'x' })) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]?.text).toContain('NOT');
      expect(result.content[0]?.text).toContain('missing, not empty');
    });

    it('should send a string for deep_research_followup even when content is missing', async () => {
      mockFollowUp.mockResolvedValue({
        content: undefined,
        interactionId: 'interaction-11',
        status: 'completed',
      } as unknown as DeepResearchResult);

      const result = (await server.callTool('deep_research_followup', {
        interactionId: 'interaction-11',
        question: 'why?',
      })) as { content: Array<{ text: unknown }> };

      expect(typeof result.content[0]?.text).toBe('string');
      expect(String(result.content[0]?.text).length).toBeGreaterThan(0);
    });

    it('should pass real content through untouched', async () => {
      mockDeepResearch.mockResolvedValue({
        content: 'A real report.',
        interactionId: 'interaction-12',
        status: 'completed',
      });

      const result = (await server.callTool('deep_research', { topic: 'x' })) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0]?.text).toBe('A real report.');
    });
  });

  // ── Structured error codes ───────────────────────────────────────────

  describe('error responses', () => {
    let server: GeminiDeepResearchMcpServer;

    beforeEach(async () => {
      server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      await server.initialize();
    });

    async function errorFor(thrown: unknown) {
      mockDeepResearch.mockRejectedValue(thrown);
      const result = (await server.callTool('deep_research', { topic: 'x' })) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      return JSON.parse(String(result.content[0]?.text)) as {
        error: string;
        message: string;
        hint?: string;
      };
    }

    it('should report an invalid key rejected as a 400, not just a 401', async () => {
      // The Gemini API answers a bad key with 400 INVALID_ARGUMENT /
      // API_KEY_INVALID. The old `includes('401') || includes('403')` branch
      // never fired for it, so the commonest credential failure arrived as a
      // generic RESEARCH_FAILED.
      const thrown = Object.assign(
        new Error(
          '{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
        ),
        { status: 400 },
      );
      const body = await errorFor(thrown);
      expect(body.error).toBe('INVALID_API_KEY');
      expect(body.hint).toBeTruthy();
    });

    it('should keep the code out of the message', async () => {
      const body = await errorFor(new Error('429 Too Many Requests'));
      expect(body.error).toBe('RATE_LIMITED');
      expect(body.message).toBe('429 Too Many Requests');
      expect(body.message).not.toContain('RATE_LIMITED');
    });

    it('should carry a hint that separates quota from credentials', async () => {
      const rateLimited = await errorFor(new Error('429 Too Many Requests'));
      const badKey = await errorFor(new Error('401 Unauthorized'));
      expect(rateLimited.hint).toBeTruthy();
      expect(badKey.hint).toBeTruthy();
      expect(rateLimited.hint).not.toBe(badKey.hint);
    });

    it('should not classify an incidental number as a status code', async () => {
      const body = await errorFor(new Error('request took 401 ms'));
      expect(body.error).toBe('API_ERROR');
    });

    it('should use the same classification the client uses', async () => {
      // The guard against the two lists drifting apart again: whatever
      // `classifyGeminiError` decides is exactly what the tool response says.
      const samples: unknown[] = [
        new Error('401 Unauthorized'),
        new Error('403 PERMISSION_DENIED'),
        new Error('429 Too Many Requests'),
        new Error('Research Timeout after 60 minutes'),
        new Error('ECONNREFUSED'),
        Object.assign(new Error('{"error":{"code":503}}'), { status: 503 }),
      ];
      for (const sample of samples) {
        const body = await errorFor(sample);
        expect(body.error, String(sample)).toBe(classifyGeminiError(sample).code);
      }
    });
  });

  describe('listResources', () => {
    it('should return empty array', async () => {
      const server = new GeminiDeepResearchMcpServer(apiKeyConfig);
      const resources = await server.listResources();
      expect(resources).toEqual([]);
    });
  });
});
