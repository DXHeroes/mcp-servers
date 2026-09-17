import { describe, expect, it } from 'vitest';
import { classifyToolTier } from '../../src/utils/tool-classification.js';

describe('classifyToolTier', () => {
  it('classifies annotation invariants', () => {
    expect(classifyToolTier({ readOnlyHint: true })).toBe('read-only');
    expect(classifyToolTier({ destructiveHint: true })).toBe('destructive');
    expect(classifyToolTier({ readOnlyHint: true, destructiveHint: true })).toBe('read-only');
    expect(classifyToolTier(undefined)).toBe('write');
    expect(classifyToolTier({})).toBe('write');
  });
});
