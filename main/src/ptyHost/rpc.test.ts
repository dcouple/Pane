import { describe, expect, it } from 'vitest';
import { isPtyHostResponse } from './rpc';

describe('isPtyHostResponse', () => {
  it('accepts successful void responses with no result property', () => {
    expect(isPtyHostResponse({ id: 7, ok: true })).toBe(true);
  });

  it('accepts successful spawn responses', () => {
    expect(isPtyHostResponse({
      id: 8,
      ok: true,
      result: { ptyId: 'pty-8', pid: 42 },
    })).toBe(true);
  });
});
