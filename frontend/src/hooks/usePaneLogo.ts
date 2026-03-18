import paneLogoDark from '../assets/pane-logo-dark.svg';
import paneLogoLight from '../assets/pane-logo-light.svg';
import { useTheme } from '../contexts/ThemeContext';

export function usePaneLogo(): string {
  const { theme } = useTheme();
  return theme === 'light' || theme === 'light-rounded' ? paneLogoLight : paneLogoDark;
}
