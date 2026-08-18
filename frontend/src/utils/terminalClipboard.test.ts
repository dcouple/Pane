import { describe, expect, it } from 'vitest';
import { isTerminalCopyShortcut } from './terminalClipboard';

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
  return {
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('isTerminalCopyShortcut', () => {
  it('uses Cmd+C on macOS', () => {
    expect(isTerminalCopyShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isTerminalCopyShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isTerminalCopyShortcut(key({ ctrlKey: true, shiftKey: true }), true)).toBe(false);
  });

  it('uses Ctrl+Shift+C outside macOS', () => {
    expect(isTerminalCopyShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isTerminalCopyShortcut(key({ ctrlKey: true }), false)).toBe(false);
    expect(isTerminalCopyShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it('does not intercept modified copy shortcuts', () => {
    expect(isTerminalCopyShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isTerminalCopyShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
  });
});
