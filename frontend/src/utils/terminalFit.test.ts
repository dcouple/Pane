import { describe, expect, it } from 'vitest';
import {
  fitFontSize,
  fittedWidth,
  MAX_TILE_FONT_SIZE,
  MIN_TILE_FONT_SIZE,
  widestLine,
} from './terminalFit';

// What the app's default terminal font measures at in the running app.
const RATIO = 0.6;

describe('fitFontSize', () => {
  it('picks the largest size at which every column still fits', () => {
    // 80 columns in 480px of glyph width is exactly 10px per em at this ratio.
    expect(fitFontSize(80 * 10 * RATIO, 80, RATIO)).toBe(10);
  });

  it('never goes below the legibility floor, however narrow the box', () => {
    expect(fitFontSize(20, 200, RATIO)).toBe(MIN_TILE_FONT_SIZE);
  });

  it('holds to the ceiling rather than filling a wide box with huge text', () => {
    expect(fitFontSize(4000, 20, RATIO)).toBe(MAX_TILE_FONT_SIZE);
  });

  it('honours a caller ceiling above the tile default', () => {
    expect(fitFontSize(4000, 20, RATIO, 16)).toBe(16);
  });

  it('treats an unmeasured box as the floor rather than dividing by zero', () => {
    expect(fitFontSize(0, 80, RATIO)).toBe(MIN_TILE_FONT_SIZE);
    expect(fitFontSize(500, 0, RATIO)).toBe(MAX_TILE_FONT_SIZE);
  });
});

describe('fittedWidth', () => {
  it('counts the terminal chrome that sits beside the glyphs', () => {
    // Without the chrome the trailing column lands outside the tile, which is
    // the hard cut mid-word this pair of helpers exists to prevent.
    expect(fittedWidth(10, 80, RATIO)).toBeGreaterThan(80 * 10 * RATIO);
  });

  it('agrees with fitFontSize that a fitted screen fits', () => {
    const width = 600;
    const columns = 40;
    const fontSize = fitFontSize(width, columns, RATIO);
    expect(fittedWidth(fontSize, columns, RATIO)).toBeLessThanOrEqual(width);
  });

  it('reports a screen that cannot fit even at the floor', () => {
    const width = 200;
    const columns = 200;
    expect(fitFontSize(width, columns, RATIO)).toBe(MIN_TILE_FONT_SIZE);
    expect(fittedWidth(MIN_TILE_FONT_SIZE, columns, RATIO)).toBeGreaterThan(width);
  });
});

describe('widestLine', () => {
  it('measures the widest row of a snapshot with no PTY dimensions', () => {
    expect(widestLine('ab\nabcd\nabc')).toBe(4);
  });

  it('is zero for empty text, so callers fall back rather than divide by it', () => {
    expect(widestLine('')).toBe(0);
  });
});
