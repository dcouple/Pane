import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { areKeyboardShortcutsEnabled, isCommandPaletteShortcutEnabled, useConfigStore } from './configStore';
import { useHotkeyStore } from './hotkeyStore';

describe('hotkeyStore keyboard shortcut preference', () => {
  let keydownListener: ((event: KeyboardEvent) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
        if (type === 'keydown') keydownListener = listener;
      },
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    useHotkeyStore.getState().unregister('test-shortcut');
    useHotkeyStore.getState().unregister('open-command-palette');
    useConfigStore.setState({ config: null });
    vi.unstubAllGlobals();
  });

  it('does not execute or prevent disabled Pane shortcuts', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutsEnabled: false } });
    useHotkeyStore.getState().register({
      id: 'test-shortcut',
      label: 'Test shortcut',
      keys: 'mod+w',
      category: 'tabs',
      action,
    });

    keydownListener?.({
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: { tagName: 'DIV', isContentEditable: false, closest: () => null },
      getModifierState: () => false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('waits for config while preserving legacy enabled behavior', () => {
    expect(areKeyboardShortcutsEnabled(null)).toBe(false);
    expect(areKeyboardShortcutsEnabled({})).toBe(true);
    expect(isCommandPaletteShortcutEnabled(null)).toBe(false);
    expect(isCommandPaletteShortcutEnabled({ keyboardShortcutsEnabled: false })).toBe(true);
  });

  it('allows only the Command Palette shortcut when configured as an exception', () => {
    const paletteAction = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutsEnabled: false } });
    useHotkeyStore.getState().register({
      id: 'open-command-palette',
      label: 'Open Command Palette',
      keys: 'mod+shift+p',
      category: 'navigation',
      action: paletteAction,
    });

    keydownListener?.({
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      target: { tagName: 'DIV', isContentEditable: false, closest: () => null },
      getModifierState: () => false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(paletteAction).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();

    useConfigStore.setState({
      config: {
        keyboardShortcutsEnabled: false,
        commandPaletteShortcutEnabled: false,
      },
    });
    keydownListener?.({
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      target: { tagName: 'DIV', isContentEditable: false, closest: () => null },
      getModifierState: () => false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(paletteAction).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
