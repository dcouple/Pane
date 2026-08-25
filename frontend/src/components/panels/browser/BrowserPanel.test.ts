import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './browserUrl';

describe('normalizeUrl', () => {
  it('preserves file URLs for local HTML previews', () => {
    expect(normalizeUrl('file:///tmp/Pane%20Preview/index.html')).toBe(
      'file:///tmp/Pane%20Preview/index.html',
    );
  });

  it('keeps existing web URL behavior', () => {
    expect(normalizeUrl('localhost:4173')).toBe('http://localhost:4173');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });
});
