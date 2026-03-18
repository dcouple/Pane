import React, { createContext, useContext, useEffect, useState } from 'react';
import { useConfigStore } from '../stores/configStore';
import { API } from '../utils/api';

type Theme = 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled' | 'forge' | 'ember' | 'aurora';

const VALID_THEMES: Theme[] = ['light', 'light-rounded', 'dark', 'oled', 'dusk', 'dusk-oled', 'forge', 'ember', 'aurora'];
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
};
const isValidTheme = (t: string): t is Theme => VALID_THEMES.includes(t as Theme);

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { config } = useConfigStore();
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('theme');
    if (saved && isValidTheme(saved)) {
      return saved;
    }
    return 'light-rounded';
  });
  const [configLoaded, setConfigLoaded] = useState(false);

  // Sync theme from config when it loads
  useEffect(() => {
    if (config?.theme && isValidTheme(config.theme)) {
      setTheme(config.theme);
      localStorage.setItem('theme', config.theme);
      setConfigLoaded(true);
    }
  }, [config?.theme]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;

    // Remove ALL theme classes from both root and body
    root.classList.remove('light', 'light-rounded', 'dark', 'oled', 'dusk', 'dusk-oled', 'forge', 'ember', 'aurora');
    body.classList.remove('light', 'light-rounded', 'dark', 'oled', 'dusk', 'dusk-oled', 'forge', 'ember', 'aurora');

    const themeClasses = THEME_CLASSES[theme];
    root.classList.add(...themeClasses);
    body.classList.add(...themeClasses);

    localStorage.setItem('theme', theme);

    if (configLoaded) {
      API.config.update({ theme }).catch(err => {
        console.error('Failed to save theme to config:', err);
      });
    }
  }, [theme, configLoaded]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
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
