import { describe, expect, it } from 'vitest';
import { resolveReviewMode } from './reviewModePreference';

describe('resolveReviewMode', () => {
  it('uses local review when no pull request exists', () => {
    expect(resolveReviewMode('github', false)).toBe('local');
    expect(resolveReviewMode('local', false)).toBe('local');
  });

  it('preserves the preferred mode when a pull request exists', () => {
    expect(resolveReviewMode('github', true)).toBe('github');
    expect(resolveReviewMode('local', true)).toBe('local');
  });
});
