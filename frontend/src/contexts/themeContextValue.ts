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
