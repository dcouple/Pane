import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_CLASSES } from './themeContextValue';

// index.html applies theme classes before React loads (to avoid a flash) from a
// hand-copied map. Both copies must match ThemeProvider's THEME_CLASSES.
function parseBootstrapMaps(html: string): Array<Record<string, string[]>> {
  const maps: Array<Record<string, string[]>> = [];
  const objectRe = /const (?:themeClasses|tc) = \{([\s\S]*?)\};/g;
  let match: RegExpExecArray | null;
  while ((match = objectRe.exec(html)) !== null) {
    const map: Record<string, string[]> = {};
    const entryRe = /'([\w-]+)':\s*\[([^\]]*)\]/g;
    let entry: RegExpExecArray | null;
    while ((entry = entryRe.exec(match[1])) !== null) {
      map[entry[1]] = entry[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    }
    maps.push(map);
  }
  return maps;
}

function parseValidLists(html: string): string[][] {
  const lists: string[][] = [];
  const re = /const (?:validThemes|vt) = \[([^\]]*)\];/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    lists.push(match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
  }
  return lists;
}

describe('index.html theme bootstrap', () => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

  it('carries the same theme → class map as ThemeProvider (head and body scripts)', () => {
    const maps = parseBootstrapMaps(html);
    expect(maps).toHaveLength(2);
    for (const map of maps) {
      expect(map).toEqual(THEME_CLASSES);
    }
  });

  it('lists every theme id as valid (head and body scripts)', () => {
    const lists = parseValidLists(html);
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect([...list].sort()).toEqual(Object.keys(THEME_CLASSES).sort());
    }
  });
});
