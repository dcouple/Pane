import { nativeTheme, type BrowserWindow } from 'electron';
import {
  APPEARANCE_ARG_PREFIX,
  encodeAppearanceSnapshotArg,
  resolveAppearanceTheme,
  themeBase,
  type AppearanceConfig,
  type AppearanceSnapshot,
  type Theme,
} from '../../../shared/types/appearance';

export type StoredBackgroundColors = Partial<Record<Theme, string>>;
export interface WindowAppearanceOptions {
  additionalArguments: string[];
  backgroundColor: string;
}

let lastOsPrefersDark: boolean | undefined;
let forwardingRegistered = false;

export function resolveOsPrefersDark(): boolean {
  if (lastOsPrefersDark === undefined || nativeTheme.themeSource === 'system') {
    lastOsPrefersDark = nativeTheme.shouldUseDarkColors;
  }
  return lastOsPrefersDark;
}

export function applyNativeThemeSource(appearance: AppearanceConfig): void {
  nativeTheme.themeSource = appearance.appearanceMode === 'system'
    ? 'system'
    : themeBase(appearance.theme);
}

export const buildAppearanceSnapshot = (appearance: AppearanceConfig): AppearanceSnapshot => ({
  appearanceMode: appearance.appearanceMode,
  theme: appearance.theme,
  systemLightTheme: appearance.systemLightTheme,
  systemDarkTheme: appearance.systemDarkTheme,
});

export function resolveWindowBackgroundColor(
  appearance: AppearanceConfig,
  osPrefersDark: boolean,
  storedColors: StoredBackgroundColors,
): string {
  const theme = resolveAppearanceTheme(appearance, osPrefersDark);
  return storedColors[theme] ?? (themeBase(theme) === 'light' ? '#ffffff' : '#0d1117');
}

export function buildWindowAppearanceOptions(
  appearance: AppearanceConfig,
  osPrefersDark: boolean,
  storedColors: StoredBackgroundColors,
): WindowAppearanceOptions {
  return {
    additionalArguments: [`${APPEARANCE_ARG_PREFIX}${encodeAppearanceSnapshotArg(buildAppearanceSnapshot(appearance))}`],
    backgroundColor: resolveWindowBackgroundColor(appearance, osPrefersDark, storedColors),
  };
}

export function ensureNativeThemeForwarding(getWindow: () => BrowserWindow | null): void {
  if (forwardingRegistered) return;
  forwardingRegistered = true;
  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource !== 'system') return;
    lastOsPrefersDark = nativeTheme.shouldUseDarkColors;
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send('window:appearance-native-updated', { prefersDark: lastOsPrefersDark });
    }
  });
}
