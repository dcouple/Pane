import { describe, expect, it } from 'vitest';
import { selectTerminalRestoreContent } from './terminalRestore';

describe('selectTerminalRestoreContent', () => {
  it('prefers the authoritative serialized state for an active alternate screen', () => {
    expect(selectTerminalRestoreContent({
      isAlternateScreen: true,
      scrollbackBuffer: 'claude --resume session-id',
      alternateScreenBuffer: '\x1b[?1049hagent output',
      serializedBuffer: '\x1b[?1049hserialized agent screen',
    })).toEqual({
      content: '\x1b[?1049hserialized agent screen',
      source: 'serialized',
    });
  });

  it('falls back to captured alternate-screen bytes for older state payloads', () => {
    expect(selectTerminalRestoreContent({
      isAlternateScreen: true,
      scrollbackBuffer: 'shell output',
      alternateScreenBuffer: '\x1b[?1049hagent output',
    })).toEqual({
      content: '\x1b[?1049hagent output',
      source: 'alternateScreen',
    });
  });

  it('keeps normal shell restoration on scrollback', () => {
    expect(selectTerminalRestoreContent({
      isAlternateScreen: false,
      scrollbackBuffer: ['first', 'second'],
      serializedBuffer: 'old snapshot',
    })).toEqual({ content: 'first\nsecond', source: 'scrollback' });
  });
});
