/**
 * Unit tests for TogglClient — reporting endpoints.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { TogglClient } from '../src/client.js';
import { mockFetch, mockResponse, setupTogglClientTest } from './client.helpers.js';

describe('TogglClient', () => {
  let client: TogglClient;

  setupTogglClientTest((c) => {
    client = c;
  });

  describe('reportSummary', () => {
    it('should POST to reports /workspace/{wid}/summary/time_entries', async () => {
      mockFetch.mockResolvedValue(mockResponse({ groups: [] }));
      await client.reportSummary({
        workspace_id: 42,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/reports/api/v3/workspace/42/summary/time_entries',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"start_date":"2024-01-01"'),
        }),
      );
    });

    it('should pass filters', async () => {
      mockFetch.mockResolvedValue(mockResponse({ groups: [] }));
      await client.reportSummary({
        workspace_id: 42,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        grouping: 'projects',
        project_ids: [1, 2],
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"grouping":"projects"'),
        }),
      );
    });
  });

  describe('reportDetailed', () => {
    it('should POST to reports /workspace/{wid}/search/time_entries', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.reportDetailed({
        workspace_id: 42,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/reports/api/v3/workspace/42/search/time_entries',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('reportWeekly', () => {
    it('should POST to reports /workspace/{wid}/weekly/time_entries', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.reportWeekly({
        workspace_id: 42,
        start_date: '2024-01-01',
        end_date: '2024-01-07',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/reports/api/v3/workspace/42/weekly/time_entries',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('reportProjectSummary', () => {
    it('should POST to reports /workspace/{wid}/projects/summary', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.reportProjectSummary({
        workspace_id: 42,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/reports/api/v3/workspace/42/projects/summary',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
