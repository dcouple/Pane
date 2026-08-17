import { describe, expect, it } from 'vitest';
import { GIT_ATTRIBUTION_ENV, getGitAttributionEnv } from './attribution';

describe('getGitAttributionEnv', () => {
  it('returns the attribution env when config is undefined', () => {
    expect(getGitAttributionEnv(undefined)).toBe(GIT_ATTRIBUTION_ENV);
  });

  it('returns the attribution env when config is null', () => {
    expect(getGitAttributionEnv(null)).toBe(GIT_ATTRIBUTION_ENV);
  });

  it('returns the attribution env when gitAttributionEnabled is absent (default enabled)', () => {
    expect(getGitAttributionEnv({})).toBe(GIT_ATTRIBUTION_ENV);
  });

  it('returns the attribution env when gitAttributionEnabled is true', () => {
    expect(getGitAttributionEnv({ gitAttributionEnabled: true })).toBe(GIT_ATTRIBUTION_ENV);
  });

  it('returns an empty object when gitAttributionEnabled is false', () => {
    expect(getGitAttributionEnv({ gitAttributionEnabled: false })).toEqual({});
  });
});
