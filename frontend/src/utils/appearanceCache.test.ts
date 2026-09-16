import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE } from '../../../shared/types/appearance';
import { readAppearanceCache, readLegacyThemeAsFixed, writeAppearanceCache, type StorageLike } from './appearanceCache';

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

describe('appearance cache', () => {
  it('round-trips version one', () => {
    const storage = memoryStorage();
    writeAppearanceCache(DEFAULT_APPEARANCE, storage);
    expect(readAppearanceCache(storage)).toEqual(DEFAULT_APPEARANCE);
  });

  it('ignores garbage and interprets a valid legacy theme as fixed', () => {
    expect(readAppearanceCache(memoryStorage({ 'pane.appearance.v1': '{' }))).toBeUndefined();
    expect(readLegacyThemeAsFixed(memoryStorage({ theme: 'walnut' }))).toMatchObject({ appearanceMode: 'fixed', theme: 'walnut' });
    expect(readLegacyThemeAsFixed(memoryStorage({ theme: 'invalid' }))).toBeUndefined();
  });

  it('treats throwing storage reads and writes as best-effort', () => {
    const storageError = new DOMException('Storage is unavailable', 'SecurityError');
    const storage: StorageLike = {
      getItem: () => { throw storageError; },
      setItem: () => { throw storageError; },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(readAppearanceCache(storage)).toBeUndefined();
    expect(readLegacyThemeAsFixed(storage)).toBeUndefined();
    expect(() => writeAppearanceCache(DEFAULT_APPEARANCE, storage)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[appearanceCache] Failed to read appearance cache:',
      '[appearanceCache] Failed to read legacy theme:',
      '[appearanceCache] Failed to write appearance cache:',
    ]);
    warn.mockRestore();
  });
});
