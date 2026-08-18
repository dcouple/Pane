import { createContext } from 'react';

export type Theme =
  | 'light'
  | 'light-rounded'
  | 'dark'
  | 'oled'
  | 'dusk'
  | 'dusk-oled'
  | 'forge'
  | 'ember'
  | 'aurora'
  | 'night-owl'
  | 'night-owl-oled'
  | 'terracotta'
  | 'colorblind-safe'
  | 'low-fatigue'
  | 'high-legibility';

// Classes ThemeProvider stamps on <html>/<body> for each theme id. Every theme
// composes on `light` or `dark`. Keep in sync with the pre-React bootstrap in
// frontend/index.html (guarded by themeBootstrap.test.ts) and THEME_CLASSES in
// scripts/check-theme-contrast.mjs.
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
  'colorblind-safe': ['dark', 'colorblind-safe'],
  'low-fatigue': ['dark', 'low-fatigue'],
  'high-legibility': ['light', 'high-legibility'],
} satisfies Record<Theme, string[]>;

// Themes that compose on the `light` base class. Everything else is dark.
// Editors (Monaco, diff view, log viewer) key their built-in light/dark
// palettes off this rather than comparing theme ids one by one.
const LIGHT_THEMES: ReadonlySet<Theme> = new Set<Theme>(['light', 'light-rounded', 'high-legibility']);
export const isLightTheme = (theme: Theme): boolean => LIGHT_THEMES.has(theme);

export interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  // Read-only here: the Appearance settings toggle writes it through
  // persistence.saveConfig, and it flows back via the config sync effect.
  highContrast: boolean;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
