import { createContext } from 'react';

export type Theme = 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled' | 'forge' | 'ember' | 'aurora' | 'night-owl' | 'night-owl-oled' | 'terracotta' | 'haar' | 'abyss' | 'understory';

const LIGHT_THEMES: ReadonlySet<Theme> = new Set<Theme>(['light', 'light-rounded', 'haar']);

// Themes composed on the `light` base class (see THEME_CLASSES in ThemeProvider).
export const isLightTheme = (theme: Theme): boolean => LIGHT_THEMES.has(theme);

export interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  // Read-only here: the Appearance settings toggle writes it through
  // persistence.saveConfig, and it flows back via the config sync effect.
  highContrast: boolean;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
