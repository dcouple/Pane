import { describe, expect, it } from 'vitest';
import type { EditorDiffRef } from '../../../../../shared/types/panels';
import { diffRefLabel, editorDiffRefForFile, isMutableScope, normalizeEditorDiffRef, sameScope, scopeKey, scopeLabel } from './diffScope';

describe('diff scope helpers', () => {
  it('keys and labels every scope', () => {
    expect(scopeKey({ kind: 'session' })).toBe('session');
    expect(scopeLabel({ kind: 'session' }, { ref: 'origin/main' })).toBe('All changes · vs origin/main');
    expect(scopeLabel({ kind: 'commit', hash: 'abcdef0123' })).toBe('Commit abcdef0');
    expect(sameScope({ kind: 'working-tree' }, { kind: 'working-tree' })).toBe(true);
    expect(isMutableScope({ kind: 'working-tree-range', baseHash: 'abcdef0' })).toBe(true);
    expect(isMutableScope({ kind: 'commit', hash: 'abcdef0' })).toBe(false);
  });

  it('normalizes supported legacy refs and rejects ambiguous ranges', () => {
    expect(normalizeEditorDiffRef({ kind: 'commit', hash: 'index' })).toEqual({ scope: { kind: 'working-tree' } });
    expect(normalizeEditorDiffRef({ kind: 'range', executionIds: [0] })).toEqual({ scope: { kind: 'working-tree' } });
    expect(normalizeEditorDiffRef({ kind: 'range', executionIds: [1, 2] })).toBeNull();
    const ref: EditorDiffRef = { kind: 'scope', scope: { kind: 'session' } };
    expect(diffRefLabel(ref)).toBe('All changes');
  });
});

it('omits previousPath from the editor diff ref for non-renamed files', () => {
  const scope = { kind: 'session' } as const;
  const renamed = editorDiffRefForFile(scope, { path: 'b.ts', previousPath: 'a.ts', kind: 'renamed', additions: 0, deletions: 0, isBinary: false });
  const modified = editorDiffRefForFile(scope, { path: 'c.ts', kind: 'modified', additions: 1, deletions: 1, isBinary: false });
  expect(renamed).toEqual({ kind: 'scope', scope, previousPath: 'a.ts' });
  expect('previousPath' in modified).toBe(false);
});
