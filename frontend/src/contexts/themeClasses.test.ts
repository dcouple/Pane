import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_CLASSES } from './themeContextValue';

/**
 * frontend/index.html stamps the theme classes before React loads (to avoid a
 * flash) and therefore mirrors the shared THEME_CLASSES map once.
 * PR #362 found that copy had silently drifted; this keeps it honest.
 */
const INDEX_HTML = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../index.html'),
  'utf8',
);

/** Parse a `{ 'id': ['a', 'b'], ... }` object literal from the bootstrap script into id → class list entries. */
function parseClassMap(source: string) {
  return Object.fromEntries(
    [...source.matchAll(/'([\w-]+)':\s*\[([^\]]*)\]/g)].map((entry) => [
      entry[1],
      [...entry[2].matchAll(/'([\w-]+)'/g)].map((m) => m[1]),
    ]),
  );
}

describe('index.html theme bootstrap', () => {
  const classMaps = [...INDEX_HTML.matchAll(/const themeClasses = \{([\s\S]*?)\};/g)].map((m) => parseClassMap(m[1]));

  it('has one complete class map and the expected precedence inputs', () => {
    expect(classMaps).toHaveLength(1);
    expect(Object.keys(classMaps[0]).sort()).toEqual(Object.keys(THEME_CLASSES).sort());
    expect(INDEX_HTML).toContain('appearanceSnapshot');
    expect(INDEX_HTML).toContain('pane.appearance.v1');
    expect(INDEX_HTML).toContain('prefers-color-scheme');
  });

  it('keeps the bootstrap copy identical to THEME_CLASSES', () => {
    for (const map of classMaps) expect(map).toEqual(THEME_CLASSES);
  });

  it('every theme composes on the light or dark base', () => {
    for (const [theme, classes] of Object.entries(THEME_CLASSES)) {
      expect(['light', 'dark'], `${theme} must start with a base class`).toContain(classes[0]);
    }
  });
});
