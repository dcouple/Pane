import type { AppConfig } from '../types/config';

export function areKeyboardShortcutsEnabled(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled'>,
): boolean {
  return config.keyboardShortcutsEnabled !== false;
}

export function isCommandPaletteShortcutEnabled(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled'>,
): boolean {
  return areKeyboardShortcutsEnabled(config) || config.commandPaletteShortcutEnabled !== false;
}

export function shouldForwardCommandPaletteShortcut(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled'>,
  input: { shift: boolean; alt: boolean; code: string },
): boolean {
  return isCommandPaletteShortcutEnabled(config)
    && input.shift
    && !input.alt
    && input.code === 'KeyP';
}
