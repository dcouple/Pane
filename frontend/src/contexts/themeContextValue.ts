import { createContext } from 'react';

export type Theme = 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled' | 'forge' | 'ember' | 'aurora' | 'night-owl' | 'night-owl-oled' | 'terracotta' | 'amber-crt' | 'teletype' | 'dot-matrix';

/**
 * Class stack stamped on <html>/<body> per theme. Every theme composes on the
 * `light` or `dark` base; keep in sync with the pre-React bootstrap in
 * frontend/index.html and THEME_CLASSES in scripts/check-theme-contrast.mjs.
 */
export const THEME_CLASSES = {
  'light': ['light'],
  'light-rounded': ['light', 'light-rounded'],
  'dark': ['dark'],
  'oled': ['dark', 'oled'],
  'dusk': ['dark', 'dusk'],
  'dusk-oled': ['dark', 'dusk', 'dusk-oled'],
  'forge': ['dark', 'forge'],
  'ember': ['dark', 'ember'],
  'aurora': ['dark', 'aurora'],
  'night-owl': ['dark', 'night-owl'],
  'night-owl-oled': ['dark', 'night-owl', 'night-owl-oled'],
  'terracotta': ['dark', 'terracotta'],
  'amber-crt': ['dark', 'amber-crt'],
  'teletype': ['light', 'teletype'],
  'dot-matrix': ['dark', 'dot-matrix'],
} satisfies Record<Theme, string[]>;

/** True for themes built on the `light` base (Monaco/diff/log palettes and the logo key off this). */
export const isLightTheme = (theme: Theme): boolean => THEME_CLASSES[theme].includes('light');

export interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  // Read-only here: the Appearance settings toggle writes it through
  // persistence.saveConfig, and it flows back via the config sync effect.
  highContrast: boolean;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
