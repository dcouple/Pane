import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_CLASSES } from './themeContextValue';

/**
 * frontend/index.html stamps the theme classes before React loads (to avoid a
 * flash) and duplicates THEME_CLASSES twice — once for <html>, once for <body>.
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

function parseIdList(source: string): string[] {
  return [...source.matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
}

describe('index.html theme bootstrap', () => {
  const classMaps = [...INDEX_HTML.matchAll(/const (?:themeClasses|tc) = \{([\s\S]*?)\};/g)].map((m) => parseClassMap(m[1]));
  const idLists = [...INDEX_HTML.matchAll(/const (?:validThemes|vt) = \[([^\]]*)\];/g)].map((m) => parseIdList(m[1]));

  it('has one head and one body copy of the class map and valid-theme list', () => {
    expect(classMaps).toHaveLength(2);
    expect(idLists).toHaveLength(2);
  });

  it('keeps both copies identical to THEME_CLASSES', () => {
    for (const map of classMaps) expect(map).toEqual(THEME_CLASSES);
    for (const ids of idLists) expect(ids.sort()).toEqual(Object.keys(THEME_CLASSES).sort());
  });

  it('every theme composes on the light or dark base', () => {
    for (const [theme, classes] of Object.entries(THEME_CLASSES)) {
      expect(['light', 'dark'], `${theme} must start with a base class`).toContain(classes[0]);
    }
  });
});
