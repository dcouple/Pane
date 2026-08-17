import { describe, expect, it } from 'vitest';
import {
  isFineSurfaceScrollKey,
  isPageSurfaceScrollKey,
  resolveTerminalKeyHandling,
  shouldOpenTerminalSearch,
  terminalClaimsFineSurfaceScroll,
  TERMINAL_MULTILINE_NEWLINE_SEQUENCE,
  type TerminalKeyLike,
} from './terminalKeyHandling';

const key = (overrides: Partial<TerminalKeyLike>): TerminalKeyLike => ({
  key: 'a',
  code: 'KeyA',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  getModifierState: () => false,
  ...overrides,
});

describe('focused surface terminal key boundary', () => {
  const shiftKey = (keyName: string) => key({ key: keyName, code: keyName, shiftKey: true });

  it('recognizes only unmodified Shift+Arrow and Shift+Page chords', () => {
    expect(isFineSurfaceScrollKey(shiftKey('ArrowUp'))).toBe(true);
    expect(isPageSurfaceScrollKey(shiftKey('PageDown'))).toBe(true);
    expect(isFineSurfaceScrollKey(key({ key: 'ArrowUp', shiftKey: true, ctrlKey: true }))).toBe(false);
  });

  it('lets known CLI panels and active TUIs claim fine scrolling', () => {
    const event = shiftKey('ArrowDown');
    expect(terminalClaimsFineSurfaceScroll(event, { isCliPanel: true, isTuiActive: false })).toBe(true);
    expect(terminalClaimsFineSurfaceScroll(event, { isCliPanel: false, isTuiActive: true })).toBe(true);
    expect(terminalClaimsFineSurfaceScroll(event, { isCliPanel: false, isTuiActive: false })).toBe(false);
  });

  it('keeps coarse page scrolling owned by the terminal surface', () => {
    expect(terminalClaimsFineSurfaceScroll(
      shiftKey('PageUp'),
      { isCliPanel: true, isTuiActive: true },
    )).toBe(false);
  });
});

const tui = (overrides: Partial<{
  isTuiActive: boolean;
  isCliPanel: boolean;
  isMac: boolean;
  keyboardShortcutsEnabled: boolean;
}> = {}) => ({
  isTuiActive: true,
  isCliPanel: true,
  isMac: false,
  keyboardShortcutsEnabled: true,
  ...overrides,
});

describe('resolveTerminalKeyHandling', () => {
  it('passes keys through when Pane keyboard shortcuts are disabled', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'w', code: 'KeyW', ctrlKey: true }),
      tui({ keyboardShortcutsEnabled: false }),
    )).toEqual({ action: 'pass-through' });
  });

  it('sends the multiline sequence for Shift+Enter outside TUI mode', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'Enter', shiftKey: true }),
      tui({ isTuiActive: false, isCliPanel: false }),
    )).toEqual({ action: 'send-input', input: TERMINAL_MULTILINE_NEWLINE_SEQUENCE });
  });

  it('sends the multiline sequence for CLI agent panels in TUI mode', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'Enter', shiftKey: true }),
      tui(),
    )).toEqual({ action: 'send-input', input: TERMINAL_MULTILINE_NEWLINE_SEQUENCE });
  });

  it('passes Shift+Enter through for ordinary TUI apps', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'Enter', shiftKey: true }),
      tui({ isCliPanel: false }),
    )).toEqual({ action: 'pass-through' });
  });

  it('does not swallow Ctrl+Shift+Enter chords', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'Enter', shiftKey: true, ctrlKey: true }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });

  it('blocks Cmd/Ctrl+V in TUI mode so native paste can run', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'v', metaKey: true }),
      tui(),
    )).toEqual({ action: 'block' });
  });

  it('passes Ctrl+C through in TUI mode so fullscreen apps can handle interrupts', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'c', ctrlKey: true }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });

  it('continues to later terminal shortcut handling outside TUI mode', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: '1', metaKey: true }),
      tui({ isTuiActive: false }),
    )).toEqual({ action: 'continue' });
  });

  it.each([
    ['focus groups', key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true })],
    ['switch sessions', key({ key: 'Tab', code: 'Tab', ctrlKey: true })],
    ['switch group tabs', key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true })],
    ['add tools', key({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true })],
    ['zoom groups', key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true })],
    ['split groups', key({ key: '\\', code: 'Backslash', ctrlKey: true })],
  ])('releases Pane %s shortcuts while a TUI is active', (_label, event) => {
    expect(resolveTerminalKeyHandling(event, tui())).toEqual({ action: 'release-to-app' });
  });

  it('releases Cmd+Backslash but preserves Ctrl+Backslash on macOS', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: '\\', code: 'Backslash', metaKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'release-to-app' });
    expect(resolveTerminalKeyHandling(
      key({ key: '\\', code: 'Backslash', ctrlKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'pass-through' });
  });

  it('requires Cmd instead of Ctrl for Pane shortcuts on macOS', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'pass-through' });
    expect(resolveTerminalKeyHandling(
      key({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'release-to-app' });
  });

  it.each(['a', 'd', 'w', 'p', 'n', 'b', 'f'])(
    'preserves Ctrl+%s for the active TUI',
    (letter) => {
      expect(resolveTerminalKeyHandling(
        key({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true }),
        tui(),
      )).toEqual({ action: 'pass-through' });
    },
  );

  it('does not treat AltGr digits as Pane shortcuts', () => {
    expect(resolveTerminalKeyHandling(
      key({
        key: '1',
        code: 'Digit1',
        ctrlKey: true,
        altKey: true,
        getModifierState: (modifier) => modifier === 'AltGraph',
      }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });

  it('does not treat modified AltGr digit output as a Pane shortcut when AltGraph is unavailable', () => {
    expect(resolveTerminalKeyHandling(
      key({
        key: '@',
        code: 'Digit2',
        ctrlKey: true,
        altKey: true,
      }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });

  it('does not swallow navigation-like chords with unsupported extra modifiers', () => {
    expect(resolveTerminalKeyHandling(
      key({
        key: 'ArrowRight',
        code: 'ArrowRight',
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });
});

describe('shouldOpenTerminalSearch', () => {
  it('only opens search when Pane keyboard shortcuts are enabled', () => {
    const event = key({ key: 'f', code: 'KeyF', ctrlKey: true });
    expect(shouldOpenTerminalSearch(event, true)).toBe(true);
    expect(shouldOpenTerminalSearch(event, false)).toBe(false);
  });
});
