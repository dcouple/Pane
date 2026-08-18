#!/usr/bin/env node
/**
 * Theme contrast gate.
 *
 * Parses frontend/src/styles/tokens/colors.css, resolves each theme's tokens
 * (base light/dark block + the theme's own override block), and checks the
 * WCAG contrast pairs that matter for Pane's chrome, controls and terminal.
 *
 *   node scripts/check-theme-contrast.mjs                # every theme
 *   node scripts/check-theme-contrast.mjs amber-crt dusk # named themes only
 *   node scripts/check-theme-contrast.mjs --high-contrast amber-crt
 *
 * Exit code 1 when any pair is below its threshold.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = path.join(ROOT, 'frontend/src/styles/tokens/colors.css');

// Mirrors THEME_CLASSES in frontend/src/contexts/themeContextValue.ts.
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
  'amber-crt': ['dark', 'amber-crt'],
  'teletype': ['light', 'teletype'],
  'dot-matrix': ['dark', 'dot-matrix'],
};

const TEXT = 4.5;   // WCAG AA body text
const LARGE = 3;    // WCAG AA large text / UI components

// [foreground token, background token, minimum ratio, parent surface token?]
// rgba() values are composited over the parent surface (default --color-bg-primary)
// before measuring, so translucent tokens are judged against what they sit on.
// Deliberately NOT gated: --color-text-disabled (WCAG 1.4.3 exempts disabled
// controls — see the high-contrast note in colors.css) and 1px borders such as
// --color-input-border, which no Pane theme holds to the 3:1 UI threshold.
const PAIRS = [
  ['--color-text-primary', '--color-bg-primary', TEXT],
  ['--color-text-primary', '--color-bg-secondary', TEXT],
  ['--color-text-primary', '--color-surface-primary', TEXT],
  ['--color-text-primary', '--color-surface-secondary', TEXT],
  ['--color-text-primary', '--color-card-bg', TEXT],
  ['--color-text-primary', '--color-modal-bg', TEXT],
  ['--color-text-secondary', '--color-bg-primary', TEXT],
  ['--color-text-secondary', '--color-surface-primary', TEXT],
  ['--color-text-secondary', '--color-surface-secondary', TEXT],
  ['--color-text-tertiary', '--color-bg-primary', TEXT],
  ['--color-text-tertiary', '--color-surface-primary', TEXT],
  ['--color-text-muted', '--color-bg-primary', TEXT],
  ['--color-text-muted', '--color-surface-primary', TEXT],
  ['--color-text-interactive-muted', '--color-bg-primary', TEXT],
  ['--color-interactive-text', '--color-bg-primary', TEXT],
  ['--color-interactive-text', '--color-surface-primary', TEXT],
  ['--color-text-on-interactive', '--color-interactive-primary', TEXT],
  ['--color-text-on-interactive', '--color-interactive-hover', TEXT],
  ['--color-button-primary-text', '--color-button-primary-bg', TEXT],
  ['--color-button-primary-text', '--color-button-primary-hover', TEXT],
  ['--color-button-secondary-text', '--color-button-secondary-bg', TEXT],
  ['--color-button-secondary-text', '--color-button-secondary-hover', TEXT],
  ['--color-button-ghost-text', '--color-bg-primary', TEXT],
  ['--color-button-ghost-text', '--color-button-ghost-hover', TEXT],
  ['--color-input-text', '--color-input-bg', TEXT],
  ['--color-input-placeholder', '--color-input-bg', TEXT],
  ['--color-focus-ring', '--color-bg-primary', LARGE],
  ['--color-interactive-primary', '--color-bg-primary', LARGE],
  ['--color-status-success', '--color-bg-primary', TEXT],
  ['--color-status-warning', '--color-bg-primary', TEXT],
  ['--color-status-error', '--color-bg-primary', TEXT],
  ['--color-status-info', '--color-bg-primary', TEXT],
  ['--color-status-neutral', '--color-bg-primary', TEXT],
  ['--color-text-on-status-success', '--color-status-success', TEXT],
  ['--color-text-on-status-warning', '--color-status-warning', TEXT],
  ['--color-text-on-status-error', '--color-status-error', TEXT],
  ['--color-text-on-status-info', '--color-status-info', TEXT],
  ['--color-text-navigation-primary', '--color-surface-navigation', TEXT],
  ['--color-text-navigation-secondary', '--color-surface-navigation', TEXT],
  ['--color-text-navigation-muted', '--color-surface-navigation', TEXT],
  ['--color-text-navigation-section', '--color-surface-navigation', TEXT],
  ['--color-text-navigation-selected', '--color-surface-navigation-selected', TEXT, '--color-surface-navigation'],
  ['--color-text-navigation-hover', '--color-surface-navigation-hover', TEXT, '--color-surface-navigation'],
  ['--color-text-navigation-brand', '--color-surface-navigation', TEXT],
  ['--color-terminal-fg', '--color-terminal-bg', TEXT],
  ['--color-terminal-cursor', '--color-terminal-bg', LARGE],
  ['--color-terminal-red', '--color-terminal-bg', TEXT],
  ['--color-terminal-green', '--color-terminal-bg', TEXT],
  ['--color-terminal-yellow', '--color-terminal-bg', TEXT],
  ['--color-terminal-blue', '--color-terminal-bg', TEXT],
  ['--color-terminal-magenta', '--color-terminal-bg', TEXT],
  ['--color-terminal-cyan', '--color-terminal-bg', TEXT],
  ['--color-terminal-white', '--color-terminal-bg', TEXT],
  ['--color-terminal-bright-black', '--color-terminal-bg', LARGE],
  ['--color-terminal-bright-red', '--color-terminal-bg', TEXT],
  ['--color-terminal-bright-green', '--color-terminal-bg', TEXT],
  ['--color-terminal-bright-yellow', '--color-terminal-bg', TEXT],
  ['--color-terminal-bright-blue', '--color-terminal-bg', TEXT],
  ['--color-terminal-bright-magenta', '--color-terminal-bg', TEXT],
  ['--color-terminal-bright-cyan', '--color-terminal-bg', TEXT],
  ['--color-terminal-bright-white', '--color-terminal-bg', TEXT],
];

// ---------------------------------------------------------------------------
// CSS parsing
// ---------------------------------------------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Returns Map<selector, Map<token, value>> in source order (repeat selectors merge). */
function parseBlocks(css) {
  const blocks = new Map();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    const selector = match[1].trim();
    const body = match[2];
    const tokens = blocks.get(selector) ?? new Map();
    for (const decl of body.split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      const name = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (name.startsWith('--')) tokens.set(name, value);
    }
    blocks.set(selector, tokens);
  }
  return blocks;
}

function tokensForTheme(blocks, theme, highContrast) {
  const classes = THEME_CLASSES[theme];
  if (!classes) throw new Error(`Unknown theme "${theme}" — add it to THEME_CLASSES in this script.`);
  const merged = new Map(blocks.get(':root') ?? []);
  for (const cls of classes) {
    for (const [k, v] of blocks.get(`:root.${cls}`) ?? []) merged.set(k, v);
  }
  if (highContrast) {
    for (const cls of classes) {
      for (const [k, v] of blocks.get(`:root.high-contrast.${cls}`) ?? []) merged.set(k, v);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

function resolveVars(value, tokens, depth = 0) {
  if (depth > 20) throw new Error(`var() recursion too deep for "${value}"`);
  return value.replace(/var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (_, name, fallback) => {
    const next = tokens.get(name);
    if (next === undefined) {
      if (fallback !== undefined) return resolveVars(fallback, tokens, depth + 1);
      throw new Error(`Unresolved token ${name}`);
    }
    return resolveVars(next, tokens, depth + 1);
  });
}

/** Returns { r, g, b, a } in 0..255 / 0..1 or null. */
function parseColor(raw) {
  const value = raw.trim().toLowerCase();
  let m;
  if ((m = value.match(/^#([0-9a-f]{3,8})$/))) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split('').map((c) => parseInt(c + c, 16));
      return { r, g, b, a: hex.length === 4 ? a / 255 : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  if ((m = value.match(/^rgba?\(([^)]+)\)$/))) {
    const parts = m[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.slice(0, 3).map(Number);
    let a = 1;
    if (parts[3] !== undefined) {
      a = parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
    }
    return { r, g, b, a };
  }
  if ((m = value.match(/^(\d+)\s+(\d+)\s+(\d+)$/))) {
    // bare "r g b" triplets (e.g. --color-interactive-rgb)
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: 1 };
  }
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
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

function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = ({ r, g, b }) => '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function checkTheme(blocks, theme, highContrast) {
  const tokens = tokensForTheme(blocks, theme, highContrast);
  const failures = [];
  const skipped = [];
  const rows = [];

  const resolve = (name) => {
    const raw = tokens.get(name);
    if (raw === undefined) return { error: `missing ${name}` };
    let resolved;
    try {
      resolved = resolveVars(raw, tokens);
    } catch (error) {
      return { error: error.message };
    }
    const color = parseColor(resolved);
    if (!color) return { error: `unparseable ${name} = ${resolved}` };
    return { color };
  };

  const root = resolve('--color-bg-primary');
  if (root.error) return { failures: [root.error], skipped, rows };

  for (const [fgName, bgName, min, parentName] of PAIRS) {
    const fg = resolve(fgName);
    const bg = resolve(bgName);
    const parent = parentName ? resolve(parentName) : root;
    if (fg.error || bg.error || parent.error) {
      // A missing token is a coverage hole, not a pass — reported and counted as a failure below.
      skipped.push(`${fgName} on ${bgName}: ${fg.error ?? bg.error ?? parent.error}`);
      continue;
    }
    const parentFlat = composite(parent.color, root.color);
    const bgFlat = composite(bg.color, parentFlat);
    const fgFlat = composite(fg.color, bgFlat);
    const ratio = contrastRatio(fgFlat, bgFlat);
    const ok = ratio >= min;
    rows.push({ fgName, bgName, min, ratio, ok, fg: toHex(fgFlat), bg: toHex(bgFlat) });
    if (!ok) failures.push(`${fgName} on ${bgName}: ${ratio.toFixed(2)} < ${min} (${toHex(fgFlat)} on ${toHex(bgFlat)})`);
  }
  return { failures, skipped, rows };
}

function main() {
  const argv = process.argv.slice(2);
  const highContrast = argv.includes('--high-contrast');
  const verbose = argv.includes('--verbose');
  const themes = argv.filter((a) => !a.startsWith('--'));
  const targets = themes.length ? themes : Object.keys(THEME_CLASSES);

  const css = stripComments(readFileSync(CSS_PATH, 'utf8'));
  const blocks = parseBlocks(css);

  let failed = false;
  for (const theme of targets) {
    const { failures, skipped, rows } = checkTheme(blocks, theme, highContrast);
    const label = `${theme}${highContrast ? ' + high-contrast' : ''}`;
    if (failures.length || skipped.length) {
      failed = true;
      console.log(`✗ ${label}: ${failures.length} failing pair(s), ${skipped.length} unresolved token(s)`);
      for (const f of failures) console.log(`    ${f}`);
      for (const s of skipped) console.log(`    unresolved ${s}`);
    } else {
      console.log(`✓ ${label}: ${rows.length} pairs pass`);
    }
    if (verbose) {
      for (const r of rows) {
        console.log(`    ${r.ok ? ' ' : '!'} ${r.ratio.toFixed(2).padStart(6)} ≥ ${r.min}  ${r.fgName} (${r.fg}) on ${r.bgName} (${r.bg})`);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
