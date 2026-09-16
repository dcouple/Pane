import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_ARG_PREFIX,
  DARK_THEMES,
  DEFAULT_APPEARANCE,
  LIGHT_THEMES,
  THEME_CLASSES,
  decodeAppearanceSnapshotArg,
  encodeAppearanceSnapshotArg,
  normalizeAppearance,
  resolveAppearanceTheme,
} from '../../../shared/types/appearance';

describe('shared appearance model', () => {
  it('classifies every theme from its base class', () => {
    expect(LIGHT_THEMES).toEqual(['light', 'light-rounded', 'folio', 'newsprint', 'teletype', 'haar', 'high-legibility']);
    expect(DARK_THEMES).toEqual(['dark', 'oled', 'dusk', 'dusk-oled', 'forge', 'ember', 'aurora', 'night-owl', 'night-owl-oled', 'terracotta', 'synthwave', 'acid', 'tokyo-rain', 'walnut', 'amber-crt', 'dot-matrix', 'abyss', 'understory', 'colorblind-safe', 'low-fatigue']);
    expect([...LIGHT_THEMES, ...DARK_THEMES].sort()).toEqual(Object.keys(THEME_CLASSES).sort());
  });

  it('defaults a new install and migrates legacy light and dark themes', () => {
    expect(normalizeAppearance({}).appearance).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ theme: 'forge' }).appearance).toEqual({
      appearanceMode: 'fixed', theme: 'forge', systemLightTheme: 'light-rounded', systemDarkTheme: 'forge',
    });
    expect(normalizeAppearance({ theme: 'folio' }).appearance).toEqual({
      appearanceMode: 'fixed', theme: 'folio', systemLightTheme: 'folio', systemDarkTheme: 'dark',
    });
  });

  it('repairs invalid fields independently and records diagnostics', () => {
    const light = normalizeAppearance({ appearanceMode: 'system', systemLightTheme: 'dark', systemDarkTheme: 'forge' });
    expect(light.appearance.systemLightTheme).toBe('light-rounded');
    expect(light.appearance.systemDarkTheme).toBe('forge');
    expect(light.diagnostics).toContain('invalid systemLightTheme; restored light-rounded');

    const dark = normalizeAppearance({ appearanceMode: 'fixed', theme: 'unknown', systemLightTheme: 'folio', systemDarkTheme: 'folio' });
    expect(dark.appearance).toEqual({ appearanceMode: 'fixed', theme: 'light-rounded', systemLightTheme: 'folio', systemDarkTheme: 'dark' });
    expect(dark.diagnostics).toHaveLength(2);
  });

  it('resolves fixed and both system slots', () => {
    const appearance = { ...DEFAULT_APPEARANCE, systemLightTheme: 'folio' as const, systemDarkTheme: 'forge' as const };
    expect(resolveAppearanceTheme(appearance, false)).toBe('folio');
    expect(resolveAppearanceTheme(appearance, true)).toBe('forge');
    expect(resolveAppearanceTheme({ ...appearance, appearanceMode: 'fixed', theme: 'abyss' }, false)).toBe('abyss');
  });

  it('round-trips a snapshot and rejects missing or corrupt arguments', () => {
    const encoded = encodeAppearanceSnapshotArg(DEFAULT_APPEARANCE);
    expect(decodeAppearanceSnapshotArg([`${APPEARANCE_ARG_PREFIX}${encoded}`])).toEqual(DEFAULT_APPEARANCE);
    expect(decodeAppearanceSnapshotArg([])).toBeUndefined();
    expect(decodeAppearanceSnapshotArg([`${APPEARANCE_ARG_PREFIX}garbage`])).toBeUndefined();
  });
});
