/**
 * Unit tests for TogglClient — buildErrorHint and extractErrorMessage.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import { buildErrorHint, extractErrorMessage } from '../src/client.js';
import { setupTogglClientTest } from './client.helpers.js';

describe('TogglClient', () => {
  setupTogglClientTest();

  describe('buildErrorHint', () => {
    it('should mention the paid plan for a 403 on a task endpoint', () => {
      const hint = buildErrorHint('FORBIDDEN', 'Forbidden', '/workspaces/1/tasks');
      expect(hint).toContain('paid');
      expect(hint).toContain('Starter');
    });

    it('should mention the paid plan for a 402 that involves a task', () => {
      const hint = buildErrorHint('PAYMENT_REQUIRED', 'Payment required', '/workspaces/1/tasks/2');
      expect(hint).toContain('Starter');
    });

    it('should give the generic permission hint for a 403 off the task endpoints', () => {
      const hint = buildErrorHint('FORBIDDEN', 'Forbidden', '/workspaces/1/projects');
      expect(hint).toContain('valid but not allowed');
      expect(hint).not.toContain('Starter');
    });

    it('should point at the list tools on a 404', () => {
      const hint = buildErrorHint('NOT_FOUND', 'Not found', '/workspaces/1/projects/2');
      expect(hint).toContain('toggl_list_projects');
    });

    it('should prefer the task hint over the date hint for "Time entry ... task"', () => {
      // A bare "time" must not trigger the date lecture — Toggl phrases many
      // unrelated 400s as "Time entry ...".
      const hint = buildErrorHint(
        'BAD_REQUEST',
        'Time entry must have a task in this workspace',
        '/workspaces/1/time_entries',
      );
      expect(hint).toContain('toggl_list_tasks');
      expect(hint).not.toContain('RFC 3339');
    });

    it('should still give the date hint for a genuine date error', () => {
      const hint = buildErrorHint(
        'BAD_REQUEST',
        'start must be a valid date',
        '/workspaces/1/time_entries',
      );
      expect(hint).toContain('RFC 3339');
    });

    it('should give the date hint for the snake_case report field names', () => {
      // `_` is a word character: `\bstart\b` never matched `start_date`, so
      // the most common Reports error got no hint at all.
      for (const message of [
        'start_date must not be after end_date',
        'end_date is required',
        // Was `duration_field` — an invented field name that no longer
        // matches, and never appeared in Toggl's API definition. A hint tested
        // against invented prose only proves the regex matches itself.
        'end_time is invalid',
      ]) {
        expect(
          buildErrorHint('BAD_REQUEST', message, '/workspace/1/summary/time_entries'),
        ).toContain('date-only');
      }
    });

    it('should prefer the project hint over the date hint on a Track endpoint', () => {
      const hint = buildErrorHint(
        'BAD_REQUEST',
        'Invalid project_id for start',
        '/workspaces/1/time_entries',
      );
      expect(hint).toContain('toggl_list_projects');
    });

    it('should return undefined for an unclassifiable 400', () => {
      expect(buildErrorHint('BAD_REQUEST', 'something odd', '/workspaces/1/tags')).toBeUndefined();
    });
  });

  describe('extractErrorMessage', () => {
    it('should return the fallback for an empty body', () => {
      expect(extractErrorMessage('', 'Bad Request')).toBe('Bad Request');
      expect(extractErrorMessage('   ', 'Bad Request')).toBe('Bad Request');
    });

    it('should unwrap a quoted JSON string', () => {
      expect(extractErrorMessage('"nope"', 'fallback')).toBe('nope');
    });

    it('should pass plain text through', () => {
      expect(extractErrorMessage('nope', 'fallback')).toBe('nope');
    });

    it('should fall back when the JSON body is an empty string', () => {
      expect(extractErrorMessage('""', 'Bad Request')).toBe('Bad Request');
    });

    it('should fall back only when a JSON body carries no readable text', () => {
      expect(extractErrorMessage('[]', 'Bad Request')).toBe('Bad Request');
      expect(extractErrorMessage('{}', 'Bad Request')).toBe('Bad Request');
      expect(extractErrorMessage('{"count":3,"ok":false}', 'Bad Request')).toBe('Bad Request');
      expect(extractErrorMessage('null', 'Bad Request')).toBe('Bad Request');
    });

    it('should recover the leaf text of a field-keyed error map', () => {
      expect(
        extractErrorMessage(
          '{"errors":{"start_date":["must not be after end_date"]}}',
          'Bad Request',
        ),
      ).toBe('start_date: must not be after end_date');
      // A generic container key is not worth quoting as a label.
      expect(extractErrorMessage('{"reason":"invalid grouping value"}', 'Bad Request')).toBe(
        'invalid grouping value',
      );
      // Nested field maps keep the field name that identifies the culprit.
      expect(extractErrorMessage('{"data":{"project_ids":{"0":"not found"}}}', 'Bad Request')).toBe(
        'project_ids: not found',
      );
    });

    it('should keep the recovered message short and free of JSON punctuation', () => {
      const body = JSON.stringify({
        errors: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`field_${i}`, ['x'.repeat(40)]]),
        ),
      });
      const message = extractErrorMessage(body, 'Bad Request');
      expect(message.length).toBeLessThanOrEqual(301);
      expect(message).not.toContain('{');
    });
  });
});
