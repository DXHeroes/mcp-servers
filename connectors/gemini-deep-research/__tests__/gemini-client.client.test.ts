/**
 * Unit tests for GeminiClient - API key validation, deep research, follow-ups
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyGeminiError, isCredentialProblem } from '../src/errors.js';
import { GeminiClient } from '../src/gemini-client.js';
import { getMocks } from './gemini-client.helpers.js';

// Mock the @google/genai module (vi.mock is hoisted per file, so it is repeated
// rather than shared; the mock functions themselves live in the helper module)
vi.mock('@google/genai', async () => {
  const { mockInteractionsCreate, mockInteractionsGet, mockModelsList } = await import(
    './gemini-client.helpers.js'
  );
  return {
    GoogleGenAI: class MockGoogleGenAI {
      interactions = {
        create: mockInteractionsCreate,
        get: mockInteractionsGet,
      };
      models = {
        list: mockModelsList,
      };
    },
  };
});

vi.mock('node:timers/promises', () => ({ setTimeout: async () => undefined }));
afterEach(() => vi.restoreAllMocks());

describe('GeminiClient', () => {
  let client: GeminiClient;
  let mocks: ReturnType<typeof getMocks>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GeminiClient('test-api-key');
    mocks = getMocks();
  });

  describe('validateApiKey', () => {
    it('should return valid: true for a valid key', async () => {
      // Mock async iterator
      mocks.models.list.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield { name: 'models/gemini-pro' };
        },
      });

      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: true });
    });

    it('should return invalid for 401 error', async () => {
      mocks.models.list.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Invalid API key' });
    });

    it('should return invalid for 403 error', async () => {
      mocks.models.list.mockRejectedValue(new Error('403 PERMISSION_DENIED'));

      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Invalid API key' });
    });

    it('should return validation failed for network errors', async () => {
      mocks.models.list.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Validation failed: ECONNREFUSED' });
    });

    it('should reject a key the API rejects with a 400, not only a 401', async () => {
      // The Gemini API answers an invalid key with 400 INVALID_ARGUMENT /
      // API_KEY_INVALID. The old private substring list did catch this one via
      // 'API_KEY_INVALID' — the server's did not, which is exactly the drift
      // the shared classifier removes.
      mocks.models.list.mockRejectedValue(
        Object.assign(
          new Error(
            '{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
          ),
          { status: 400 },
        ),
      );

      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Invalid API key' });
    });

    it('should not blame the key for a rate limit or an outage', async () => {
      for (const thrown of [new Error('429 Too Many Requests'), new Error('503 UNAVAILABLE')]) {
        mocks.models.list.mockRejectedValue(thrown);
        const result = await client.validateApiKey();
        expect(result.valid, thrown.message).toBe(false);
        expect(result.error, thrown.message).not.toBe('Invalid API key');
      }
    });

    it('should agree with the shared classifier on every sample', async () => {
      // The guard that keeps this method and the server's handleApiError from
      // drifting apart again: whether validateApiKey says "Invalid API key" is
      // decided by the same classification the tool-call path reports.
      const samples: unknown[] = [
        new Error('401 Unauthorized'),
        new Error('403 PERMISSION_DENIED'),
        new Error('429 Too Many Requests'),
        new Error('Research Timeout after 60 minutes'),
        new Error('ECONNREFUSED'),
        new Error('request took 401 ms'),
        Object.assign(
          new Error('{"error":{"code":400,"details":[{"reason":"API_KEY_INVALID"}]}}'),
          {
            status: 400,
          },
        ),
      ];

      for (const sample of samples) {
        mocks.models.list.mockRejectedValue(sample);
        const result = await client.validateApiKey();
        const expectedCredentialProblem = isCredentialProblem(classifyGeminiError(sample).code);
        expect(result.error === 'Invalid API key', String(sample)).toBe(expectedCredentialProblem);
      }
    });
  });

  describe('deepResearch', () => {
    it('should pass store: true to interactions.create', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      mocks.interactions.get.mockResolvedValue({
        id: 'interaction-1',
        status: 'completed',
        outputs: [{ type: 'text', text: 'Research results' }],
      });

      await client.deepResearch({ topic: 'test topic' });

      expect(mocks.interactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          store: true,
          background: true,
          agent: 'deep-research-pro-preview-12-2025',
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }),
      );
    });

    it('should append format instructions to the prompt', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      mocks.interactions.get.mockResolvedValue({
        id: 'interaction-1',
        status: 'completed',
        outputs: [{ type: 'text', text: 'Formatted results' }],
      });

      await client.deepResearch({
        topic: 'AI impact',
        formatInstructions: 'Format as bullet points',
      });

      expect(mocks.interactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          input: 'AI impact\n\nFormat as bullet points',
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }),
      );
    });

    it('should return completed result with content and citations', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      mocks.interactions.get.mockResolvedValue({
        id: 'interaction-1',
        status: 'completed',
        outputs: [
          {
            type: 'text',
            text: 'Research findings',
            annotations: [{ type: 'url_citation', url: 'https://source.com' }],
          },
        ],
      });

      const result = await client.deepResearch({ topic: 'test' });

      expect(result).toEqual({
        content: 'Research findings',
        interactionId: 'interaction-1',
        citations: ['https://source.com'],
        status: 'completed',
      });
    });

    it('should poll until completion', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      // First poll: in_progress, second poll: completed
      mocks.interactions.get
        .mockResolvedValueOnce({
          id: 'interaction-1',
          status: 'in_progress',
        })
        .mockResolvedValueOnce({
          id: 'interaction-1',
          status: 'completed',
          outputs: [{ type: 'text', text: 'Done' }],
        });

      const result = await client.deepResearch({ topic: 'test' });
      expect(result.status).toBe('completed');
      expect(mocks.interactions.get).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
    });

    it('should return failed result on failure status', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      mocks.interactions.get.mockResolvedValue({
        id: 'interaction-1',
        status: 'failed',
      });

      const result = await client.deepResearch({ topic: 'test' });

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
    });

    it('should handle cancelled status', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      mocks.interactions.get.mockResolvedValue({
        id: 'interaction-1',
        status: 'cancelled',
      });

      const result = await client.deepResearch({ topic: 'test' });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('cancelled');
    });

    it('should handle requires_action status', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      mocks.interactions.get.mockResolvedValue({
        id: 'interaction-1',
        status: 'requires_action',
      });

      const result = await client.deepResearch({ topic: 'test' });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('requires action');
    });

    it('should throw on timeout', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      mocks.interactions.get.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      // Mock Date.now to jump past 60 minutes after the first get call
      const realDateNow = Date.now;
      let callCount = 0;
      const startTime = realDateNow();
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        // After a few calls, jump past 60 minutes
        if (callCount > 4) {
          return startTime + 61 * 60 * 1000;
        }
        return startTime;
      });

      // Already classified at the throw site, so the server does not have to
      // recognise the wording to report it as a timeout. Asserted on a single
      // call: the Date.now stub in this test cannot be driven twice.
      await expect(client.deepResearch({ topic: 'test' })).rejects.toMatchObject({
        name: 'GeminiApiError',
        code: 'TIMEOUT',
        message: expect.stringContaining('Research timed out after 60 minutes'),
      });

      vi.restoreAllMocks();
    });

    it('should find the last text content in outputs', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'interaction-1',
        status: 'in_progress',
      });

      mocks.interactions.get.mockResolvedValue({
        id: 'interaction-1',
        status: 'completed',
        outputs: [
          { type: 'text', text: 'First draft' },
          { type: 'image' },
          { type: 'text', text: 'Final version' },
        ],
      });

      const result = await client.deepResearch({ topic: 'test' });
      expect(result.content).toBe('Final version');
    });
  });

  describe('followUp', () => {
    it('should use model parameter instead of agent', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'followup-1',
        status: 'completed',
        outputs: [{ type: 'text', text: 'Follow-up answer' }],
      });

      await client.followUp('prev-interaction-id', 'What about X?');

      expect(mocks.interactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-2.5-pro',
          previous_interaction_id: 'prev-interaction-id',
          input: 'What about X?',
        }),
      );

      // Should NOT have agent parameter
      const callArgs = mocks.interactions.create.mock.calls[0]?.[0];
      expect(callArgs).not.toHaveProperty('agent');
    });

    it('should return content from follow-up response', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'followup-1',
        status: 'completed',
        outputs: [{ type: 'text', text: 'The answer is 42' }],
      });

      const result = await client.followUp('prev-id', 'What is the meaning?');

      expect(result).toEqual({
        content: 'The answer is 42',
        interactionId: 'followup-1',
        status: 'completed',
      });
    });

    it('should handle empty outputs', async () => {
      mocks.interactions.create.mockResolvedValue({
        id: 'followup-1',
        status: 'completed',
        outputs: [],
      });

      const result = await client.followUp('prev-id', 'Question');
      expect(result.content).toBe('');
    });
  });
});
