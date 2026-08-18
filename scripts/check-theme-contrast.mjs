#!/usr/bin/env node
// Checks WCAG contrast for every theme defined in frontend/src/styles/tokens/colors.css.
//
// Resolves `var()` chains the same way the browser cascade would for a given
// theme class list (base :root → parent theme blocks → own block), then checks
// the token pairs that matter most: body text on its background, navigation
// text on the sidebar, button text on button fills, status/focus colors, and
// the terminal foreground plus 16-color ANSI palette on the terminal
// background. Alpha colors are composited over the paired background.
//
// Every theme is checked twice: as-is, and with the additive `high-contrast`
// class, where the muted text family must reach AAA (7:1).
//
// Usage: node scripts/check-theme-contrast.mjs [theme-id ...]   (pnpm check:theme-contrast)
//   No arguments checks every theme. VERBOSE=1 prints passing pairs too.
//   Exit code 1 if any pair fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../frontend/src/styles/tokens/colors.css');
const css = readFileSync(cssPath, 'utf8');

// Mirrors THEME_CLASSES in frontend/src/contexts/ThemeProvider.tsx.
const THEME_CLASSES = {
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
  'haar': ['light', 'haar'],
  'abyss': ['dark', 'abyss'],
  'understory': ['dark', 'understory'],
};

const AA_TEXT = 4.5;
const AA_UI = 3;
const AAA_TEXT = 7;

// [foreground token, background token, minimum ratio]
const CHECKS = [
  ['--color-text-primary', '--color-bg-primary', AA_TEXT],
  ['--color-text-secondary', '--color-bg-primary', AA_TEXT],
  ['--color-text-tertiary', '--color-bg-primary', AA_TEXT],
  ['--color-text-muted', '--color-bg-primary', AA_TEXT],
  ['--color-text-primary', '--color-bg-editor', AA_TEXT],
  ['--color-text-primary', '--color-surface-primary', AA_TEXT],
  ['--color-text-on-surface', '--color-surface-primary', AA_TEXT],
  ['--color-text-secondary', '--color-surface-secondary', AA_TEXT],
  ['--color-text-interactive-muted', '--color-bg-primary', AA_TEXT],
  ['--color-interactive-text', '--color-bg-primary', AA_TEXT],
  ['--color-text-navigation-primary', '--color-surface-navigation', AA_TEXT],
  ['--color-text-navigation-secondary', '--color-surface-navigation', AA_TEXT],
  ['--color-text-navigation-muted', '--color-surface-navigation', AA_TEXT],
  ['--color-text-navigation-section', '--color-surface-navigation', AA_TEXT],
  ['--color-text-navigation-selected', '--color-surface-navigation', AA_TEXT],
  ['--color-button-primary-text', '--color-button-primary-bg', AA_TEXT],
  ['--color-button-primary-text', '--color-button-primary-hover', AA_TEXT],
  ['--color-button-secondary-text', '--color-button-secondary-bg', AA_TEXT],
  ['--color-button-secondary-text', '--color-button-secondary-hover', AA_TEXT],
  ['--color-button-ghost-text', '--color-bg-primary', AA_TEXT],
  ['--color-input-text', '--color-input-bg', AA_TEXT],
  ['--color-input-placeholder', '--color-input-bg', AA_TEXT],
  ['--color-status-success', '--color-bg-primary', AA_UI],
  ['--color-status-warning', '--color-bg-primary', AA_UI],
  ['--color-status-error', '--color-bg-primary', AA_UI],
  ['--color-status-info', '--color-bg-primary', AA_UI],
  ['--color-focus-ring', '--color-bg-primary', AA_UI],
  ['--color-terminal-fg', '--color-terminal-bg', AA_TEXT],
  ['--color-terminal-cursor', '--color-terminal-bg', AA_UI],
  ...[
    'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'bright-black', 'bright-red', 'bright-green', 'bright-yellow', 'bright-blue',
    'bright-magenta', 'bright-cyan', 'bright-white',
  ].map((name) => [`--color-terminal-${name}`, '--color-terminal-bg', AA_UI]),
];

// Checked again with the additive `high-contrast` class (Settings → Appearance).
const HIGH_CONTRAST_CHECKS = [
  ['--color-text-muted', '--color-bg-primary', AAA_TEXT],
  ['--color-text-interactive-muted', '--color-bg-primary', AAA_TEXT],
  ['--color-text-navigation-muted', '--color-surface-navigation', AAA_TEXT],
  ['--color-text-navigation-section', '--color-surface-navigation', AAA_TEXT],
];

// --- CSS parsing -----------------------------------------------------------

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Returns an array of { selector, declarations: Map }.
function parseBlocks(text) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const selector = match[1].trim();
    const declarations = new Map();
    for (const decl of match[2].split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      const name = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (name.startsWith('--')) declarations.set(name, value);
    }
    blocks.push({ selector, declarations });
  }
  return blocks;
}

const blocks = parseBlocks(stripComments(css));

function tokensForClasses(classes, highContrast = false) {
  const map = new Map();
  const apply = (block) => { for (const [k, v] of block.declarations) map.set(k, v); };
  for (const block of blocks) if (block.selector === ':root') apply(block);
  for (const cls of classes) {
    for (const block of blocks) if (block.selector === `:root.${cls}`) apply(block);
  }
  if (highContrast) {
    // `.high-contrast` is additive; its blocks are ordered like the theme blocks so
    // derived variants (oled, dusk-oled, ...) win over their parent.
    for (const cls of classes) {
      for (const block of blocks) if (block.selector === `:root.high-contrast.${cls}`) apply(block);
    }
  }
  return map;
}

// --- Color math -------------------------------------------------------------

function parseColor(raw) {
  const value = raw.trim();
  let m = value.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  m = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

function resolveToken(tokens, name, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const raw = tokens.get(name);
  if (raw === undefined) return null;
  const varMatch = raw.match(/^var\((--[\w-]+)\)$/);
  if (varMatch) return resolveToken(tokens, varMatch[1], seen);
  // rgba(var(--x-rgb), a)
  const rgbVar = raw.match(/^rgba?\(\s*var\((--[\w-]+)\)\s*,\s*([\d.]+)\s*\)$/);
  if (rgbVar) {
    const triple = tokens.get(rgbVar[1]);
    if (!triple) return null;
    const [r, g, b] = triple.trim().split(/[\s,]+/).map(Number);
    return { r, g, b, a: Number(rgbVar[2]) };
  }
  return parseColor(raw);
}

function composite(fg, bg) {
  if (fg.a >= 1) return fg;
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const chan = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// --- Run --------------------------------------------------------------------

function evaluate(tokens, checks) {
  const bgPrimary = resolveToken(tokens, '--color-bg-primary');
  return checks.map(([fgName, bgName, min]) => {
    const bgRaw = resolveToken(tokens, bgName);
    const fgRaw = resolveToken(tokens, fgName);
    if (!bgRaw || !fgRaw) return { fgName, bgName, min, ratio: null };
    const bg = composite(bgRaw, bgPrimary ?? { r: 0, g: 0, b: 0, a: 1 });
    const fg = composite(fgRaw, bg);
    return { fgName, bgName, min, ratio: contrast(fg, bg) };
  });
}

function report(label, results) {
  const failed = results.filter((r) => r.ratio === null || r.ratio < r.min);
  const status = failed.length === 0 ? 'PASS' : 'FAIL';
  console.log(`${status} ${label} (${results.length - failed.length}/${results.length})`);
  for (const r of failed) {
    const ratio = r.ratio === null ? 'unresolved' : `${r.ratio.toFixed(2)}:1`;
    console.log(`  ✗ ${r.fgName} on ${r.bgName}: ${ratio} (min ${r.min}:1)`);
  }
  if (process.env.VERBOSE) {
    for (const r of results.filter((x) => x.ratio !== null && x.ratio >= x.min)) {
      console.log(`  ✓ ${r.fgName} on ${r.bgName}: ${r.ratio.toFixed(2)}:1`);
    }
  }
  return failed.length;
}

const requested = process.argv.slice(2);
const themeIds = requested.length > 0 ? requested : Object.keys(THEME_CLASSES);
let failures = 0;

for (const id of themeIds) {
  const classes = THEME_CLASSES[id];
  if (!classes) {
    console.error(`Unknown theme: ${id}`);
    failures += 1;
    continue;
  }
  failures += report(id, evaluate(tokensForClasses(classes), CHECKS));
  failures += report(`${id} + high-contrast`, evaluate(tokensForClasses(classes, true), HIGH_CONTRAST_CHECKS));
}

process.exit(failures > 0 ? 1 : 0);
