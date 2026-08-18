import React, { useEffect, useLayoutEffect, useState } from 'react';
import { useConfigStore } from '../stores/configStore';
import { THEME_CLASSES, ThemeContext, type Theme } from './themeContextValue';

const VALID_THEMES = new Set<string>(Object.keys(THEME_CLASSES));
// Every class any theme can stamp — removed wholesale before applying the next theme.
const ALL_THEME_CLASSES = [...new Set(Object.values(THEME_CLASSES).flat())];
const isValidTheme = (theme: string): theme is Theme => VALID_THEMES.has(theme);

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
    if (config?.highContrast !== undefined) {
      setHighContrast(config.highContrast);
      localStorage.setItem('high-contrast', String(config.highContrast));
    }
  }, [config?.highContrast]);

  // Layout effect (not passive): descendants read the stamped classes via
  // getComputedStyle in their own useEffects (terminal palette, log ANSI
  // colours), and React runs child passive effects before the parent's — a
  // passive effect here would leave them one theme behind.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const body = document.body;

    // Remove ALL theme classes from both root and body
    root.classList.remove(...ALL_THEME_CLASSES);
    body.classList.remove(...ALL_THEME_CLASSES);

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
