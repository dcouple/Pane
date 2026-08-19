import { describe, expect, it } from 'vitest';

import { toOverlayHex } from './titleBarOverlay';

describe('toOverlayHex', () => {
  it('normalises the legacy rgb() serialization the CSSOM returns', () => {
    expect(toOverlayHex('rgb(13, 17, 23)')).toBe('#0d1117');
    expect(toOverlayHex('rgb(200, 208, 217)')).toBe('#c8d0d9');
    expect(toOverlayHex('rgb(255, 255, 255)')).toBe('#ffffff');
  });

  it('drops alpha, because the overlay plate is opaque', () => {
    expect(toOverlayHex('rgba(13, 17, 23, 0.5)')).toBe('#0d1117');
    expect(toOverlayHex('rgb(13 17 23 / 50%)')).toBe('#0d1117');
    expect(toOverlayHex('#0d1117ff')).toBe('#0d1117');
    expect(toOverlayHex('#abcd')).toBe('#aabbcc');
  });

  it('accepts the hex and space-separated forms themes author tokens in', () => {
    expect(toOverlayHex('#0D1117')).toBe('#0d1117');
    expect(toOverlayHex('#abc')).toBe('#aabbcc');
    expect(toOverlayHex('rgb(13 17 23)')).toBe('#0d1117');
    expect(toOverlayHex('  rgb(13,17,23)  ')).toBe('#0d1117');
  });

  it('handles percentage channels', () => {
    expect(toOverlayHex('rgb(100%, 0%, 50%)')).toBe('#ff0080');
  });

  it('clamps out-of-range channels instead of emitting a malformed hex', () => {
    expect(toOverlayHex('rgb(300, -20, 23)')).toBe('#ff0017');
  });

  it('returns null for notations Electron would reject, so the bridge stays silent', () => {
    for (const value of ['', '   ', 'transparent', 'oklch(0.2 0.03 260)', 'color(srgb 0 0 0)', 'rgb(1, 2)', 'nonsense']) {
      expect(toOverlayHex(value)).toBeNull();
    }
  });
});
