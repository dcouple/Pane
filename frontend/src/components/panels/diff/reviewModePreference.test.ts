import { describe, expect, it } from 'vitest';
import { getEffectiveReviewMode } from './reviewModePreference';

describe('getEffectiveReviewMode', () => {
  it('falls back from GitHub to local mode when no PR URL is available', () => {
    expect(getEffectiveReviewMode('github', false)).toBe('local');
  });

  it('keeps GitHub mode when a PR URL is available', () => {
    expect(getEffectiveReviewMode('github', true)).toBe('github');
  });

  it('restores GitHub mode when a PR URL becomes available later', () => {
    const savedMode = 'github';

    expect(getEffectiveReviewMode(savedMode, false)).toBe('local');
    expect(getEffectiveReviewMode(savedMode, true)).toBe('github');
  });

  it('keeps explicit local mode regardless of PR URL availability', () => {
    expect(getEffectiveReviewMode('local', false)).toBe('local');
    expect(getEffectiveReviewMode('local', true)).toBe('local');
  });
});
