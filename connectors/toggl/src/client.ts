/**
 * Toggl Track API client — thin HTTP wrapper around fetch
 *
 * Auth: HTTP Basic — base64(apiToken:api_token)
 * Track API: https://api.track.toggl.com/api/v9
 * Reports API: https://api.track.toggl.com/reports/api/v3
 * Rate limit: 1 req/sec per IP per token
 *
 * This module stays the one import path for everything about a Toggl request.
 * The parts sit in sibling files and are re-exported here:
 *
 * - `client.errors.ts`    — error codes, `TogglApiError`, message extraction
 * - `client.hints.ts`     — remediation hints for a failed request
 * - `client.pacing.ts`    — the ~1 req/sec policy and its wait bounds
 * - `client.redaction.ts` — which response keys and value shapes are secrets
 * - `client.payload.ts`   — compaction and the list envelopes
 * - `client.http.ts`      — the transport (`TogglHttpClient`)
 * - `client.track.ts`     — Track API v9 endpoints (`TogglTrackClient`)
 *
 * What is left below is the Reports API v3 half of the endpoint surface.
 */

import { TogglTrackClient } from './client.track.js';

// Re-exported so this module stays the one import path for everything about a
// Toggl request, whichever side of the core boundary it now lives on.
export { parseRetryAfterMs, type RateLimitWaitSource } from '@dxheroes/mcp-kit';
export {
  extractErrorMessage,
  TogglApiError,
  type TogglErrorCode,
} from './client.errors.js';
export { buildErrorHint, type ErrorHintContext, type TaskReference } from './client.hints.js';
export type { TogglClientOptions } from './client.http.js';
export { __resetTogglPacingForTests } from './client.pacing.js';

/**
 * The Toggl client: every endpoint this package speaks, on one object.
 *
 * The Track API v9 endpoints come from {@link TogglTrackClient} and the
 * transport from `TogglHttpClient` beneath it; the Reports API v3 endpoints
 * are here. The split is by file only — the public surface is unchanged.
 */
export class TogglClient extends TogglTrackClient {
  // ── Reports ─────────────────────────────────────────────────────────

  async reportSummary(params: {
    workspace_id: number;
    start_date: string;
    end_date: string;
    grouping?: string;
    sub_grouping?: string;
    user_ids?: number[];
    project_ids?: number[];
    client_ids?: number[];
    tag_ids?: number[];
    billable?: boolean;
  }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.report(`/workspace/${workspace_id}/summary/time_entries`, body);
  }

  async reportDetailed(params: {
    workspace_id: number;
    start_date: string;
    end_date: string;
    user_ids?: number[];
    project_ids?: number[];
    client_ids?: number[];
    tag_ids?: number[];
    billable?: boolean;
    page_size?: number;
    first_row_number?: number;
  }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.report(`/workspace/${workspace_id}/search/time_entries`, body);
  }

  async reportWeekly(params: {
    workspace_id: number;
    start_date: string;
    end_date: string;
    user_ids?: number[];
    project_ids?: number[];
    client_ids?: number[];
    tag_ids?: number[];
    billable?: boolean;
  }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.report(`/workspace/${workspace_id}/weekly/time_entries`, body);
  }

  async reportProjectSummary(params: {
    workspace_id: number;
    start_date: string;
    end_date: string;
  }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.report(`/workspace/${workspace_id}/projects/summary`, body);
  }
}
