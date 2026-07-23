import React, { createContext, useContext, useEffect, useState } from 'react';
import { useConfigStore } from '../stores/configStore';

type Theme = 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled' | 'forge' | 'ember' | 'aurora' | 'night-owl' | 'night-owl-oled' | 'terracotta';

const VALID_THEMES: Theme[] = ['light', 'light-rounded', 'dark', 'oled', 'dusk', 'dusk-oled', 'forge', 'ember', 'aurora', 'night-owl', 'night-owl-oled', 'terracotta'];
const THEME_CLASSES: Record<Theme, string[]> = {
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
};
const isValidTheme = (t: string): t is Theme => VALID_THEMES.includes(t as Theme);

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  // Read-only here: the Appearance settings toggle writes it through
  // persistence.saveConfig, and it flows back via the config sync effect.
  highContrast: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { config, updateConfig } = useConfigStore();
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('theme');
    if (saved && isValidTheme(saved)) {
      return saved;
    }
    return 'light-rounded';
  });
  const [highContrast, setHighContrast] = useState<boolean>(() => localStorage.getItem('high-contrast') === 'true');

  // Sync theme from config when it loads
  useEffect(() => {
    if (config?.theme && isValidTheme(config.theme)) {
      setTheme(config.theme);
      localStorage.setItem('theme', config.theme);
    }
  }, [config?.theme]);

  // Sync high contrast from config when it loads
  useEffect(() => {
    if (typeof config?.highContrast === 'boolean') {
      setHighContrast(config.highContrast);
      localStorage.setItem('high-contrast', String(config.highContrast));
    }
  }, [config?.highContrast]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;

    // Remove ALL theme classes from both root and body
    root.classList.remove('light', 'light-rounded', 'dark', 'oled', 'dusk', 'dusk-oled', 'forge', 'ember', 'aurora', 'night-owl', 'night-owl-oled', 'terracotta');
    body.classList.remove('light', 'light-rounded', 'dark', 'oled', 'dusk', 'dusk-oled', 'forge', 'ember', 'aurora', 'night-owl', 'night-owl-oled', 'terracotta');

    const themeClasses = THEME_CLASSES[theme];
    root.classList.add(...themeClasses);
    body.classList.add(...themeClasses);

    // High contrast is additive on top of the theme classes
    root.classList.remove('high-contrast');
    body.classList.remove('high-contrast');
    if (highContrast) {
      root.classList.add('high-contrast');
      body.classList.add('high-contrast');
    }

    localStorage.setItem('theme', theme);

  }, [theme, highContrast]);

  const updateTheme = (nextTheme: Theme) => {
    const previousTheme = theme;
    setTheme(nextTheme);
    localStorage.setItem('theme', nextTheme);
    void updateConfig({ theme: nextTheme }).catch((error) => {
      console.error('Failed to save theme to config:', error);
      setTheme(previousTheme);
      localStorage.setItem('theme', previousTheme);
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: updateTheme, highContrast }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
};
