import { describe, it, expect } from 'vitest';
import { linearScale, niceTicks, niceMax, arcPath, formatTokens, formatUsd } from './chartScales';

describe('linearScale', () => {
  it('maps the domain onto the range linearly', () => {
    expect(linearScale(5, 0, 10, 0, 100)).toBe(50);
    expect(linearScale(0, 0, 10, 20, 120)).toBe(20);
    expect(linearScale(10, 0, 10, 20, 120)).toBe(120);
  });

  it('supports an inverted range, as SVG y-axes need', () => {
    expect(linearScale(10, 0, 10, 100, 0)).toBe(0);
    expect(linearScale(0, 0, 10, 100, 0)).toBe(100);
  });

  it('collapses a zero-width domain to the range start instead of dividing by zero', () => {
    expect(linearScale(5, 5, 5, 0, 100)).toBe(0);
  });
});

describe('niceTicks', () => {
  it('returns a usable axis for an empty chart', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(-5)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });

  it('always starts at zero and covers the max', () => {
    for (const max of [1, 7, 93, 1234, 987_654]) {
      const ticks = niceTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('produces evenly spaced round steps', () => {
    const ticks = niceTicks(100, 4);
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 6);
    }
    expect([1, 2, 5, 10, 20, 25, 50].some(candidate => Math.abs(step - candidate) < 1e-9)).toBe(true);
  });

  it('handles a max of 1 without collapsing the axis', () => {
    expect(niceTicks(1)).toEqual([0, 0.5, 1]);
  });
});

describe('niceMax', () => {
  it('rounds up to the top tick', () => {
    expect(niceMax(93)).toBeGreaterThanOrEqual(93);
    expect(niceMax(0)).toBe(1);
  });
});

describe('arcPath', () => {
  it('returns an empty path for a zero-width or reversed segment', () => {
    expect(arcPath(50, 50, 40, 25, 0.5, 0.5)).toBe('');
    expect(arcPath(50, 50, 40, 25, 0.8, 0.2)).toBe('');
  });

  it('draws a full circle as two arcs', () => {
    const path = arcPath(50, 50, 40, 25, 0, 1);
    expect(path.match(/M /g)).toHaveLength(2);
  });

  it('clamps fractions above 1', () => {
    const clamped = arcPath(50, 50, 40, 25, 0, 1.4);
    const full = arcPath(50, 50, 40, 25, 0, 1);
    expect(clamped).toBe(full);
  });

  it('sets the large-arc flag only past a half turn', () => {
    expect(arcPath(50, 50, 40, 25, 0, 0.25)).toContain('0 1');
    expect(arcPath(50, 50, 40, 25, 0, 0.75)).toContain('1 1');
  });
});

describe('formatTokens', () => {
  it('abbreviates by magnitude', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1200)).toBe('1.2K');
    expect(formatTokens(3_400_000)).toBe('3.4M');
    expect(formatTokens(2_500_000_000)).toBe('2.5B');
  });

  it('handles zero and non-finite input', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(Number.NaN)).toBe('0');
  });
});

describe('formatUsd', () => {
  it('marks sub-cent amounts rather than showing $0.00', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});
