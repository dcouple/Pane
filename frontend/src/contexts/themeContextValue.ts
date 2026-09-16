import { createContext } from 'react';
import type { AppearanceConfig, Theme } from '../../../shared/types/appearance';

export { THEME_CLASSES, isLightTheme } from '../../../shared/types/appearance';
export type { Theme } from '../../../shared/types/appearance';

export interface ThemeContextType {
  theme: Theme;
  appearance: AppearanceConfig;
  prefersDark: boolean;
  activeSystemSlot: 'light' | 'dark' | undefined;
  setTheme: (theme: Theme) => Promise<void>;
  setAppearance: (patch: Partial<AppearanceConfig>) => Promise<void>;
  // Read-only here: the Appearance settings toggle writes it through
  // persistence.saveConfig, and it flows back via the config sync effect.
  highContrast: boolean;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
