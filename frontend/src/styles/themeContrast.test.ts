import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_CLASSES } from '../contexts/themeContextValue';

/**
 * Static WCAG contrast gate over the theme tokens in tokens/colors.css.
 *
 * Resolves each theme's cascade the same way the browser does (`:root` dark
 * base → `:root.light` → `:root.<theme>` → OLED child → `.high-contrast`),
 * composites alpha colours over the surface they sit on, and checks the
 * ratios that PR #362 measured by hand. New themes register in FULL_THEMES
 * so text, buttons, focus rings and the 16 ANSI colours are all gated.
 */

const COLORS_CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'tokens/colors.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];
type TokenMap = Map<string, string>;

const AA_TEXT = 4.5;
const AA_UI = 3;
const AAA_TEXT = 7;

type ThemeId = keyof typeof THEME_CLASSES;
// SAFETY: THEME_CLASSES is a closed object literal, so its keys are exactly ThemeId.
const ALL_THEMES = Object.keys(THEME_CLASSES) as ThemeId[];

// Themes that ship with the full contrast matrix (add new themes here).
const FULL_THEMES: ThemeId[] = ['folio', 'newsprint', 'walnut'];

const MUTED_FAMILY = [
  '--color-text-muted',
  '--color-text-interactive-muted',
  '--color-text-navigation-muted',
  '--color-text-navigation-section',
];

const ANSI = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow', 'bright-blue', 'bright-magenta', 'bright-cyan',
];

// --- CSS parsing -----------------------------------------------------------

/** All `{ ... }` bodies whose selector list matches `selector` exactly, in source order. */
function blocksFor(selector: string): string[] {
  const bodies: string[] = [];
  for (const match of COLORS_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) bodies.push(match[2]);
  }
  return bodies;
}

function collectDeclarations(body: string, into: TokenMap): void {
  for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    into.set(decl[1], decl[2].trim());
  }
}

/** Resolve the token map a browser would see for the given class list. */
function tokensFor(classes: string[], highContrast = false): TokenMap {
  const tokens: TokenMap = new Map();
  for (const body of blocksFor(':root')) collectDeclarations(body, tokens);
  // Same specificity, so source order decides — mirror it by walking the classes
  // in the order colors.css declares them (light before the print themes, dark
  // parents before their OLED children), which THEME_CLASSES already encodes.
  for (const cls of classes) for (const body of blocksFor(`:root.${cls}`)) collectDeclarations(body, tokens);
  if (highContrast) {
    for (const cls of classes) for (const body of blocksFor(`:root.high-contrast.${cls}`)) collectDeclarations(body, tokens);
  }
  return tokens;
}

// --- Colour maths ----------------------------------------------------------

function substituteVars(value: string, tokens: TokenMap, depth = 0): string {
  if (depth > 16) throw new Error(`var() recursion too deep in ${value}`);
  const next = value.replace(/var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (_m, name: string, fallback?: string) => {
    const resolved = tokens.get(name) ?? fallback;
    if (resolved === undefined) throw new Error(`Unresolved token ${name}`);
    return resolved;
  });
  return next.includes('var(') ? substituteVars(next, tokens, depth + 1) : next;
}

function parseColor(raw: string): Rgba {
  const value = raw.trim();
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return [Number(fn[1]), Number(fn[2]), Number(fn[3]), alpha];
  }
  if (value === 'transparent') return [0, 0, 0, 0];
  throw new Error(`Cannot parse colour "${raw}"`);
}

function resolveColor(name: string, tokens: TokenMap): Rgba {
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`Token ${name} is not defined`);
  return parseColor(substituteVars(raw, tokens));
}

function composite([r, g, b, a]: Rgba, [br, bg, bb]: Rgb): Rgb {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
  // Backgrounds with alpha are assumed to sit on an opaque page; that is close
  // enough for the surfaces gated here (all opaque in practice).
  const solidBg: Rgb = [bg[0], bg[1], bg[2]];
  const solidFg = composite(fg, solidBg);
  const [hi, lo] = [luminance(solidFg), luminance(solidBg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function ratioOf(tokens: TokenMap, fg: string, bg: string): number {
  return contrast(resolveColor(fg, tokens), resolveColor(bg, tokens));
}

function expectRatio(tokens: TokenMap, fg: string, bg: string, min: number, label: string): void {
  const ratio = ratioOf(tokens, fg, bg);
  expect(ratio, `${label}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1, need ≥ ${min}:1`).toBeGreaterThanOrEqual(min);
}

// --- Tests -----------------------------------------------------------------

describe('theme contrast (tokens/colors.css)', () => {
  it('declares theme blocks in THEME_CLASSES order so the cascade model matches the browser', () => {
    // Same specificity everywhere, so source order decides. The resolver
    // above walks THEME_CLASSES in order; that is only faithful if colors.css
    // lists each class's block (and its high-contrast block) in that order.
    for (const theme of ALL_THEMES) {
      const classes = THEME_CLASSES[theme];
      for (const prefix of [':root.', ':root.high-contrast.']) {
        // Not every class owns a block (the dark base is bare `:root`, light-rounded
        // inherits `.light`'s high-contrast block) — only the blocks that exist must be ordered.
        const offsets = classes
          .map((cls) => ({ cls, offset: COLORS_CSS.indexOf(`${prefix}${cls} {`) }))
          .filter(({ offset }) => offset >= 0);
        for (let i = 1; i < offsets.length; i += 1) {
          expect(offsets[i].offset, `${prefix}${offsets[i].cls} must come after ${prefix}${offsets[i - 1].cls}`)
            .toBeGreaterThan(offsets[i - 1].offset);
        }
      }
    }
  });

  describe.each(ALL_THEMES)('%s', (theme) => {
    const tokens = tokensFor(THEME_CLASSES[theme]);
    const hcTokens = tokensFor(THEME_CLASSES[theme], true);

    it('keeps the muted text family at AA against --color-bg-primary', () => {
      for (const token of MUTED_FAMILY) expectRatio(tokens, token, '--color-bg-primary', AA_TEXT, theme);
    });

    it('lifts the muted text family to AAA in high-contrast mode', () => {
      for (const token of MUTED_FAMILY) expectRatio(hcTokens, token, '--color-bg-primary', AAA_TEXT, `${theme} (high-contrast)`);
    });
  });

  describe.each(FULL_THEMES)('%s (full matrix)', (theme) => {
    const tokens = tokensFor(THEME_CLASSES[theme]);

    it('body text reads on every surface it can land on', () => {
      const surfaces = [
        '--color-bg-primary', '--color-bg-secondary', '--color-bg-tertiary', '--color-bg-hover', '--color-bg-active',
        '--color-bg-chrome', '--color-bg-editor',
        '--color-surface-primary', '--color-surface-secondary', '--color-surface-tertiary',
        '--color-card-bg', '--color-card-nested-bg', '--color-modal-bg', '--color-input-bg',
        '--color-surface-navigation', '--color-surface-navigation-hover',
      ];
      for (const bg of surfaces) {
        for (const fg of ['--color-text-primary', '--color-text-secondary', '--color-text-tertiary', '--color-text-muted']) {
          expectRatio(tokens, fg, bg, AA_TEXT, theme);
        }
      }
      // Navigation text on the sidebar surfaces
      for (const bg of ['--color-surface-navigation', '--color-surface-navigation-hover', '--color-surface-navigation-active']) {
        for (const fg of ['--color-text-navigation-primary', '--color-text-navigation-secondary', '--color-text-navigation-muted', '--color-text-navigation-selected', '--color-text-navigation-section']) {
          expectRatio(tokens, fg, bg, AA_TEXT, theme);
        }
      }
      expectRatio(tokens, '--color-input-text', '--color-input-bg', AA_TEXT, theme);
      expectRatio(tokens, '--color-input-placeholder', '--color-input-bg', AA_TEXT, theme);
    });

    it('links, accents, status and focus meet AA text / 3:1 UI on the page', () => {
      for (const bg of ['--color-bg-primary', '--color-bg-editor', '--color-bg-chrome', '--color-surface-primary']) {
        expectRatio(tokens, '--color-interactive-text', bg, AA_TEXT, theme);
        expectRatio(tokens, '--color-text-interactive-on-dark', bg, AA_TEXT, theme);
        expectRatio(tokens, '--color-status-neutral', bg, AA_UI, theme);
        for (const ui of ['--color-interactive-primary', '--color-focus-ring', '--color-border-focus', '--color-status-success', '--color-status-warning', '--color-status-error', '--color-status-info']) {
          expectRatio(tokens, ui, bg, AA_UI, theme);
        }
      }
    });

    it('buttons keep their label readable in every state', () => {
      expectRatio(tokens, '--color-button-primary-text', '--color-button-primary-bg', AA_TEXT, theme);
      expectRatio(tokens, '--color-button-primary-text', '--color-button-primary-hover', AA_TEXT, theme);
      expectRatio(tokens, '--color-text-on-interactive', '--color-interactive-primary', AA_TEXT, theme);
      expectRatio(tokens, '--color-text-on-interactive', '--color-interactive-hover', AA_TEXT, theme);
      expectRatio(tokens, '--color-text-on-interactive', '--color-interactive-active', AA_TEXT, theme);
      expectRatio(tokens, '--color-button-secondary-text', '--color-button-secondary-bg', AA_TEXT, theme);
      expectRatio(tokens, '--color-button-secondary-text', '--color-button-secondary-hover', AA_TEXT, theme);
      expectRatio(tokens, '--color-button-ghost-text', '--color-bg-primary', AA_TEXT, theme);
      expectRatio(tokens, '--color-button-ghost-text', '--color-button-ghost-hover', AA_TEXT, theme);
      for (const status of ['success', 'warning', 'error', 'info']) {
        expectRatio(tokens, `--color-text-on-status-${status}`, `--color-status-${status}`, AA_TEXT, theme);
      }
    });

    it('terminal palette reads on the terminal background', () => {
      expectRatio(tokens, '--color-terminal-fg', '--color-terminal-bg', AA_TEXT, theme);
      expectRatio(tokens, '--color-terminal-white', '--color-terminal-bg', AA_TEXT, theme);
      expectRatio(tokens, '--color-terminal-bright-white', '--color-terminal-bg', AA_TEXT, theme);
      expectRatio(tokens, '--color-terminal-cursor', '--color-terminal-bg', AA_UI, theme);
      for (const name of ANSI) expectRatio(tokens, `--color-terminal-${name}`, '--color-terminal-bg', AA_UI, theme);
      // The terminal background must be one of the theme's own surfaces, not a fallback.
      const termBg = resolveColor('--color-terminal-bg', tokens);
      const editorBg = resolveColor('--color-bg-editor', tokens);
      expect(termBg.slice(0, 3)).toEqual(editorBg.slice(0, 3));
    });

    it('overrides every token the base light and dark themes define (no half-theme fallbacks)', () => {
      const own: TokenMap = new Map();
      for (const body of blocksFor(`:root.${theme}`)) collectDeclarations(body, own);
      const expected = new Set<string>();
      for (const selector of [':root.light', ':root.terracotta']) {
        const block: TokenMap = new Map();
        for (const body of blocksFor(selector)) collectDeclarations(body, block);
        for (const name of block.keys()) expected.add(name);
      }
      const missing = [...expected].filter((name) => !own.has(name));
      expect(missing, `${theme} is missing: ${missing.join(', ')}`).toEqual([]);
    });
  });
});
