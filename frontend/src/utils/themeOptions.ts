import type { Theme } from '../contexts/themeContextValue';

export interface ThemeOption {
  id: Theme;
  label: string;
  /** One-line vibe shown under the label in theme pickers. */
  description: string;
}

// Picker order: light themes first, then the atmosphere set (Haar, Abyss,
// Understory), the other dark families, and finally the sharp GitHub-style
// defaults. Every Theme id must appear here exactly once.
export const THEME_OPTIONS = [
  { id: 'light-rounded', label: 'Light (rounded)', description: 'Clean white with rounded, islanded panels' },
  { id: 'light', label: 'Light (sharp)', description: 'Clean white, flat edge-to-edge chrome' },
  { id: 'haar', label: 'Haar', description: 'Pre-dawn sea fog — cold blue-white surfaces, ink text' },
  { id: 'abyss', label: 'Abyss', description: 'Deep ocean — near-black navy, bioluminescent teal accent' },
  { id: 'understory', label: 'Understory', description: 'Forest floor — moss greens, bark-brown chrome, lichen accent' },
  { id: 'forge', label: 'Forge', description: 'IntelliJ-style two-tone graphite with a blue accent' },
  { id: 'night-owl', label: 'Night Owl', description: 'Warm rose and crimson, no blue light' },
  { id: 'night-owl-oled', label: 'Night Owl (OLED)', description: 'Night Owl on pure-black foundations' },
  { id: 'dusk', label: 'Dusk', description: 'Achromatic navy-gray with soft radii' },
  { id: 'dusk-oled', label: 'Dusk (OLED)', description: 'Dusk on pure-black foundations' },
  { id: 'ember', label: 'Ember', description: 'Synthwave graphite with a copper-pink glow' },
  { id: 'aurora', label: 'Aurora', description: 'Rosé Pine-inspired romantic dark' },
  { id: 'terracotta', label: 'Terracotta', description: 'Warm dusty earth tones, no blue light' },
  { id: 'dark', label: 'Dark (sharp)', description: 'GitHub-style dark, flat edge-to-edge chrome' },
  { id: 'oled', label: 'OLED Black (sharp)', description: 'True black for OLED displays' },
] as const satisfies readonly ThemeOption[];

type CoveredTheme = (typeof THEME_OPTIONS)[number]['id'];

// SAFETY: the cast narrows Object.fromEntries' string-keyed result to the ids that are
// literally present in THEME_OPTIONS; assigning that to Record<Theme, string> is a
// compile-time check that every Theme id has an entry (a missing id fails typecheck).
const THEME_LABELS: Record<Theme, string> = Object.fromEntries(
  THEME_OPTIONS.map((option) => [option.id, option.label]),
) as Record<CoveredTheme, string>;

export const getThemeLabel = (theme: Theme): string => THEME_LABELS[theme];
