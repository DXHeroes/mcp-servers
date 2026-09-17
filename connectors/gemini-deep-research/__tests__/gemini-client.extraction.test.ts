/**
 * Unit tests for GeminiClient - content/citation extraction helpers
 */

import { describe, expect, it, vi } from 'vitest';
import { extractCitations, extractTextFromContent } from '../src/gemini-client.js';

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

describe('extractTextFromContent', () => {
  it('should extract text from TextContent', () => {
    expect(extractTextFromContent({ type: 'text', text: 'hello world' })).toBe('hello world');
  });

  it('should return empty string for non-text content', () => {
    expect(extractTextFromContent({ type: 'image' })).toBe('');
  });

  it('should return empty string when text is undefined', () => {
    expect(extractTextFromContent({ type: 'text' })).toBe('');
  });
});

describe('extractCitations', () => {
  it('should extract source from annotations', () => {
    const result = {
      id: 'test-id',
      status: 'completed' as const,
      outputs: [
        {
          type: 'text',
          text: 'Some research content',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://example.com/article1',
              start_index: 0,
              end_index: 10,
            },
            {
              type: 'url_citation',
              url: 'https://example.com/article2',
              start_index: 20,
              end_index: 30,
            },
          ],
        },
      ],
    };

    const citations = extractCitations(result);
    expect(citations).toEqual(['https://example.com/article1', 'https://example.com/article2']);
  });

  it('should handle missing annotations', () => {
    const result = {
      id: 'test-id',
      status: 'completed' as const,
      outputs: [{ type: 'text', text: 'No citations here' }],
    };

    expect(extractCitations(result)).toEqual([]);
  });

  it('should handle empty outputs', () => {
    const result = {
      id: 'test-id',
      status: 'completed' as const,
      outputs: [],
    };

    expect(extractCitations(result)).toEqual([]);
  });

  it('should handle missing outputs', () => {
    const result = {
      id: 'test-id',
      status: 'completed' as const,
    };

    expect(extractCitations(result)).toEqual([]);
  });

  it('should deduplicate citations', () => {
    const result = {
      id: 'test-id',
      status: 'completed' as const,
      outputs: [
        {
          type: 'text',
          text: 'Content',
          annotations: [
            { type: 'url_citation', url: 'https://example.com/same' },
            { type: 'url_citation', url: 'https://example.com/same' },
            { type: 'url_citation', url: 'https://example.com/different' },
          ],
        },
      ],
    };

    const citations = extractCitations(result);
    expect(citations).toEqual(['https://example.com/same', 'https://example.com/different']);
  });

  it('should skip annotations without source', () => {
    const result = {
      id: 'test-id',
      status: 'completed' as const,
      outputs: [
        {
          type: 'text',
          text: 'Content',
          annotations: [
            { type: 'place_citation', start_index: 0, end_index: 10 },
            { type: 'url_citation', url: 'https://example.com/valid' },
          ],
        },
      ],
    };

    expect(extractCitations(result)).toEqual(['https://example.com/valid']);
  });

  it('should skip non-text outputs', () => {
    const result = {
      id: 'test-id',
      status: 'completed' as const,
      outputs: [
        { type: 'image' },
        {
          type: 'text',
          text: 'Content',
          annotations: [{ type: 'url_citation', url: 'https://example.com' }],
        },
      ],
    };

    expect(extractCitations(result)).toEqual(['https://example.com']);
  });
});
