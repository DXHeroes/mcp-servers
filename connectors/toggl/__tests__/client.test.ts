/**
 * Unit tests for TogglClient — core requests, auth and secret redaction.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TogglClient } from '../src/client.js';
import { TogglApiError } from '../src/client.js';
import {
  API_TOKEN,
  expectedAuth,
  mockFetch,
  mockResponse,
  newClient,
  setupTogglClientTest,
  syntheticHexToken,
} from './client.helpers.js';

describe('TogglClient', () => {
  let client: TogglClient;

  setupTogglClientTest((c) => {
    client = c;
  });

  describe('constructor', () => {
    it('should compute Basic auth header from api token', async () => {
      const c = newClient('my-token');
      mockFetch.mockResolvedValue(mockResponse({ id: 1 }));
      // Awaited: the request now passes through the rate-limit pacer, so
      // `fetch` is no longer reached in the same synchronous turn.
      await c.me({});
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.track.toggl.com/api/v9'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('my-token:api_token').toString('base64')}`,
          }),
        }),
      );
    });

    it('should allow custom base URLs', async () => {
      const c = newClient('my-token', 'https://custom.api.com', 'https://custom.reports.com');
      mockFetch.mockResolvedValue(mockResponse({}));
      await c.me({});
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://custom.api.com'),
        expect.any(Object),
      );
    });
  });

  describe('validateApiKey', () => {
    it('should return valid: true on 200 response', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 123, email: 'test@test.com' }));
      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/me',
        expect.objectContaining({
          method: 'GET',
          headers: { Authorization: expectedAuth },
        }),
      );
    });

    it('should return invalid on 403 response', async () => {
      mockFetch.mockResolvedValue(mockResponse('Forbidden', 403));
      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Invalid API token' });
    });

    it('should return error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Validation failed: ECONNREFUSED' });
    });
  });

  // ── User & Workspace ────────────────────────────────────────────────

  describe('me', () => {
    it('should call GET /me', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 1, email: 'test@test.com' }));
      const result = await client.me({});
      expect(result).toEqual({ id: 1, email: 'test@test.com' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/me',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should pass with_related_data param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 1 }));
      await client.me({ with_related_data: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/me?with_related_data=true',
        expect.any(Object),
      );
    });
  });

  describe('listWorkspaces', () => {
    it('should call GET /me/workspaces', async () => {
      mockFetch.mockResolvedValue(mockResponse([{ id: 1, name: 'My Workspace' }]));
      const result = await client.listWorkspaces();
      expect(result).toEqual([{ id: 1, name: 'My Workspace' }]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/me/workspaces',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('getWorkspace', () => {
    it('should call GET /workspaces/{id}', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 42, name: 'Test WS' }));
      await client.getWorkspace({ workspace_id: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/42',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  // ── Secret redaction  ───────────────────────────────────

  describe('secret redaction', () => {
    const TOKEN = syntheticHexToken('b');

    it('should redact api_token in the /me response, keeping the key visible', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ id: 1, email: 'test@test.com', api_token: TOKEN }),
      );
      const result = await client.me({});
      // The key stays with a placeholder: "withheld" and "Toggl did not return
      // it" are different facts, and dropping the key made them identical —
      // including on the day Toggl renames the field.
      expect(result).toEqual({ id: 1, email: 'test@test.com', api_token: '[REDACTED]' });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('should strip api_token from workspaces nested by with_related_data', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          id: 1,
          api_token: TOKEN,
          workspaces: [
            { id: 10, name: 'WS one', api_token: TOKEN },
            { id: 11, name: 'WS two', api_token: TOKEN },
          ],
          clients: [{ id: 20, name: 'Client', wid: 10 }],
        }),
      );
      const result = await client.me({ with_related_data: true });
      expect(result).toEqual({
        id: 1,
        api_token: '[REDACTED]',
        workspaces: [
          { id: 10, name: 'WS one', api_token: '[REDACTED]' },
          { id: 11, name: 'WS two', api_token: '[REDACTED]' },
        ],
        clients: [{ id: 20, name: 'Client', wid: 10 }],
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('should strip api_token from every entry of /me/workspaces', async () => {
      mockFetch.mockResolvedValue(
        mockResponse([
          { id: 1, name: 'My Workspace', api_token: TOKEN },
          { id: 2, name: 'Other', api_token: TOKEN },
        ]),
      );
      const result = await client.listWorkspaces();
      expect(result).toEqual([
        { id: 1, name: 'My Workspace', api_token: '[REDACTED]' },
        { id: 2, name: 'Other', api_token: '[REDACTED]' },
      ]);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('should strip api_token from the single-workspace response', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 42, name: 'Test WS', api_token: TOKEN }));
      const result = await client.getWorkspace({ workspace_id: 42 });
      expect(result).toEqual({ id: 42, name: 'Test WS', api_token: '[REDACTED]' });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('should preserve null, false and 0 values while redacting', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          id: 1,
          api_token: TOKEN,
          default_workspace_id: 0,
          openid_enabled: false,
          image_url: null,
          oauth_providers: [],
        }),
      );
      const result = await client.me({});
      expect(result).toEqual({
        id: 1,
        api_token: '[REDACTED]',
        default_workspace_id: 0,
        openid_enabled: false,
        image_url: null,
        oauth_providers: [],
      });
    });

    it('should leave a redacted key alone when Toggl returned null for it', async () => {
      // Nothing was withheld, so claiming a redaction would be a lie.
      mockFetch.mockResolvedValue(mockResponse({ id: 42, ical_url: null, ical_enabled: false }));
      await expect(client.getWorkspace({ workspace_id: 42 })).resolves.toEqual({
        id: 42,
        ical_url: null,
        ical_enabled: false,
      });
    });

    it('should tolerate a non-object payload', async () => {
      mockFetch.mockResolvedValue(mockResponse(null));
      await expect(client.me({})).resolves.toBeNull();
    });

    it('should strip the intercom identity hash from /me', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ id: 1, intercom_hash: 'abc123', api_token: TOKEN, fullname: 'Test User' }),
      );
      const result = await client.me({});
      expect(result).toEqual({
        id: 1,
        intercom_hash: '[REDACTED]',
        api_token: '[REDACTED]',
        fullname: 'Test User',
      });
    });

    it('should strip ical_url, a capability URL for the whole calendar', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          id: 42,
          name: 'Test WS',
          ical_enabled: true,
          ical_url: '/ical/workspace_user/synthetic-calendar-secret',
        }),
      );
      const result = await client.getWorkspace({ workspace_id: 42 });
      expect(result).toEqual({
        id: 42,
        name: 'Test WS',
        ical_enabled: true,
        ical_url: '[REDACTED]',
      });
      expect(JSON.stringify(result)).not.toContain('synthetic-calendar-secret');
    });

    it.each([
      ['a plural list key', { ical_urls: ['/ical/workspace_user/synthetic-calendar-secret'] }],
      ['a differently named key', { ical_url_secret: 'synthetic-calendar-secret' }],
      ['an upper-cased key', { ICAL_URL: '/ical/workspace_user/synthetic-calendar-secret' }],
      [
        'a nested generic key',
        { calendar: { url: '/ical/workspace_user/synthetic-calendar-secret' } },
      ],
      [
        'free text a user pasted',
        { description: 'subscribe: /ical/workspace_user/synthetic-calendar-secret' },
      ],
      [
        'an absolute URL in free text',
        {
          notes: 'feed https://track.toggl.com/ical/workspace_user/synthetic-calendar-secret here',
        },
      ],
    ])('should not leak an ical capability URL through %s', async (_label, payload) => {
      // The client never learns the secret of a URL it did not fetch, so the
      // key list cannot be the only defence: the path shape is scrubbed too.
      mockFetch.mockResolvedValue(mockResponse([{ id: 1, ...payload }]));
      const result = await client.listProjects({ workspace_id: 42 });
      expect(JSON.stringify(result)).not.toContain('synthetic-calendar-secret');
    });

    it('should scrub an ical secret found in one field out of every other field', async () => {
      mockFetch.mockResolvedValue(
        mockResponse([
          {
            id: 1,
            ical_url: '/ical/workspace_user/synthetic-calendar-secret',
            note: 'the token is synthetic-calendar-secret',
          },
        ]),
      );
      const result = await client.listProjects({ workspace_id: 42 });
      expect(JSON.stringify(result)).not.toContain('synthetic-calendar-secret');
    });

    it('should redact the configured token wherever it appears, not only under known keys', async () => {
      // Redaction is value-based, so an endpoint we have no special handling
      // for (and a field name Toggl may add later) cannot leak the token.
      mockFetch.mockResolvedValue(
        mockResponse([
          {
            id: 1,
            name: 'Project',
            notes: `imported with token ${API_TOKEN}`,
            some_new_field: API_TOKEN,
          },
        ]),
      );
      // Asserted on a listing that still returns the bare array, so the
      // expectation is about redaction and not about the projects envelope.
      const result = await client.listTags({ workspace_id: 42 });
      expect(JSON.stringify(result)).not.toContain(API_TOKEN);
      // A value hit reads differently from a withheld field on purpose.
      expect(result).toEqual([
        {
          id: 1,
          name: 'Project',
          notes: 'imported with token [REDACTED-SECRET]',
          some_new_field: '[REDACTED-SECRET]',
        },
      ]);
    });

    it('should redact the token when a payload puts it in the key', async () => {
      // Low realism, but the claim is "wherever it appears in the payload",
      // and Object.entries scrubbing values only would have falsified it.
      mockFetch.mockResolvedValue(mockResponse([{ [API_TOKEN]: 1 }]));
      const result = await client.listTags({ workspace_id: 42 });
      expect(JSON.stringify(result)).not.toContain(API_TOKEN);
      expect(result).toEqual([{ '[REDACTED-SECRET]': 1 }]);
    });

    it('should redact the token and the Basic credential from an error body', async () => {
      // Real scenario: an egress proxy or WAF answers with a block page that
      // echoes the request, Authorization header included.
      const encoded = Buffer.from(`${API_TOKEN}:api_token`).toString('base64');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () =>
          Promise.resolve(
            `Request blocked by policy. GET /api/v9/me Authorization: Basic ${encoded} (token ${API_TOKEN})`,
          ),
        json: () => Promise.reject(new Error('not json')),
      });
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        const message = (e as TogglApiError).message;
        expect(message).not.toContain(encoded);
        expect(message).not.toContain(API_TOKEN);
        expect(message).toContain('[REDACTED-SECRET]');
      }
    });

    it('should redact the Basic credential even when the token itself is not token-shaped', async () => {
      // The derived credential is long and cannot collide with real data, so
      // it is always scrubbed — whatever the token looks like.
      const stub = newClient('Marketing');
      const encoded = Buffer.from('Marketing:api_token').toString('base64');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve(`blocked: Authorization: Basic ${encoded}`),
        json: () => Promise.reject(new Error('not json')),
      });
      await expect(stub.me({})).rejects.toThrow(/\[REDACTED-SECRET]/);
    });

    it.each([
      [
        'a word that is also a client name',
        'Marketing',
        { name: 'Marketing', client: 'Marketing GmbH' },
      ],
      [
        'a digit string that is also a date',
        '20240115',
        { start: '20240115T09:00:00Z', description: 'ticket 20240115' },
      ],
    ])(
      'should not corrode legitimate data when the token is not token-shaped (%s)',
      async (_label, token, payload) => {
        // A misconfigured or placeholder token is normal in dev, staging and
        // first setup. Replacing it by value would leave a syntactically
        // plausible but wrong timestamp behind — which a model may well send
        // back into an update. Not scrubbing the value is the lesser evil, and
        // the constructor warns instead of degrading silently.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const stub = newClient(token);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('32 hex'));
        warn.mockRestore();
        mockFetch.mockResolvedValue(mockResponse([{ id: 1, ...payload }]));
        await expect(stub.listTags({ workspace_id: 42 })).resolves.toEqual([{ id: 1, ...payload }]);
      },
    );

    it('should not warn about the token shape for a real Toggl token', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      newClient();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('should not report the raw body when a 200 is not JSON', async () => {
      // A transparent proxy or captive portal answering 200 with the echoed
      // request is the realistic case, and the echo may carry the credentials.
      // `JSON.parse` used to run outside the scrubber, and Node quotes the
      // first characters of the body in the SyntaxError it throws.
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(`${API_TOKEN} <html>captive portal</html>`),
        json: () => Promise.reject(new Error('not json')),
      });
      try {
        await client.me({});
        expect.fail('Should have thrown');
      } catch (e) {
        const error = e as TogglApiError;
        expect(error.message).not.toContain(API_TOKEN);
        expect(error.message).not.toContain(API_TOKEN.slice(0, 10));
        expect(error.message).toContain('not JSON');
        expect(error.code).toBe('API_ERROR');
      }
    });
  });
});
