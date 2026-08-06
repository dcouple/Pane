import { describe, expect, it } from 'vitest';
import {
  areKeyboardShortcutsEnabled,
  isCommandPaletteShortcutEnabled,
  shouldForwardCommandPaletteShortcut,
} from './keyboardShortcuts';

describe('areKeyboardShortcutsEnabled', () => {
  it('defaults to enabled for existing configurations', () => {
    expect(areKeyboardShortcutsEnabled({})).toBe(true);
  });

  it('honors explicit enabled and disabled values', () => {
    expect(areKeyboardShortcutsEnabled({ keyboardShortcutsEnabled: true })).toBe(true);
    expect(areKeyboardShortcutsEnabled({ keyboardShortcutsEnabled: false })).toBe(false);
  });

  it('keeps the Command Palette shortcut as an optional exception', () => {
    expect(isCommandPaletteShortcutEnabled({ keyboardShortcutsEnabled: false })).toBe(true);
    expect(isCommandPaletteShortcutEnabled({
      keyboardShortcutsEnabled: false,
      commandPaletteShortcutEnabled: false,
    })).toBe(false);
    expect(isCommandPaletteShortcutEnabled({
      keyboardShortcutsEnabled: true,
      commandPaletteShortcutEnabled: false,
    })).toBe(true);
  });

  it('forwards only the exact Command Palette chord from embedded panels', () => {
    const config = { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: true };
    expect(shouldForwardCommandPaletteShortcut(config, { shift: true, alt: false, code: 'KeyP' })).toBe(true);
    expect(shouldForwardCommandPaletteShortcut(config, { shift: false, alt: false, code: 'KeyP' })).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(config, { shift: true, alt: true, code: 'KeyP' })).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(config, { shift: true, alt: false, code: 'KeyW' })).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(
      { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: false },
      { shift: true, alt: false, code: 'KeyP' },
    )).toBe(false);
  });
});
