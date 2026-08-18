import { createContext } from 'react';

export type Theme = 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled' | 'forge' | 'ember' | 'aurora' | 'night-owl' | 'night-owl-oled' | 'terracotta' | 'synthwave' | 'acid' | 'tokyo-rain' | 'folio' | 'newsprint' | 'walnut' | 'amber-crt' | 'teletype' | 'dot-matrix' | 'haar' | 'abyss' | 'understory';

/**
 * Class list stamped on <html>/<body> per theme. Every theme composes on the
 * `light` or `dark` base, so index 0 is the base and decides light-vs-dark
 * behaviour for code surfaces (diff view, Monaco, logs, logo).
 * Keep in sync with the pre-React bootstrap in frontend/index.html.
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
  'synthwave': ['dark', 'synthwave'],
  'acid': ['dark', 'acid'],
  'tokyo-rain': ['dark', 'tokyo-rain'],
  'folio': ['light', 'folio'],
  'newsprint': ['light', 'newsprint'],
  'walnut': ['dark', 'walnut'],
  'amber-crt': ['dark', 'amber-crt'],
  'teletype': ['light', 'teletype'],
  'dot-matrix': ['dark', 'dot-matrix'],
  'haar': ['light', 'haar'],
  'abyss': ['dark', 'abyss'],
  'understory': ['dark', 'understory'],
} satisfies Record<Theme, string[]>;

export const isLightTheme = (theme: Theme): boolean => THEME_CLASSES[theme][0] === 'light';

export interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  // Read-only here: the Appearance settings toggle writes it through
  // persistence.saveConfig, and it flows back via the config sync effect.
  highContrast: boolean;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
