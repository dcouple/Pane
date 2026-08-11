import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * `DatabaseService.initializeSchema` splits this file on `;` and prepares each
 * fragment. A `;` inside a comment therefore produces a comment-only fragment,
 * which better-sqlite3 rejects with "The supplied SQL string contains no
 * statements" — taking the whole database down with it, on every startup.
 *
 * The failure is total but the cause is invisible in review, so it is checked
 * here rather than left to be rediscovered.
 */
describe('schema.sql', () => {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  it('splits into fragments that all contain a real statement', () => {
    const offenders: string[] = [];

    for (const fragment of sql.split(';')) {
      const trimmed = fragment.trim();
      if (!trimmed) continue;

      const hasStatement = trimmed
        .split('\n')
        .some(line => line.trim() && !line.trim().startsWith('--'));

      if (!hasStatement) offenders.push(trimmed.slice(0, 120));
    }

    expect(
      offenders,
      'A comment in schema.sql contains a ";" — remove it, or startup will throw.'
    ).toEqual([]);
  });

  it('every statement is idempotent, since the file runs on every startup', () => {
    const creates = sql.match(/CREATE\s+(TABLE|INDEX)(?!\s+IF\s+NOT\s+EXISTS)/gi) ?? [];
    expect(creates).toEqual([]);
  });
});
