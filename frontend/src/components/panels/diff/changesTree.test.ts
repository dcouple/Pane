import { describe, expect, it } from 'vitest';
import type { ChangedFileSummary } from '../../../../../shared/types/gitDiff';
import {
  buildChangesTree,
  compactChains,
  defaultExpanded,
  flattenRows,
  navigate,
  reconcileExpanded,
  revealPath,
  typeAhead,
} from './changesTreeModel';

const file = (path: string): ChangedFileSummary => ({ path, kind: 'modified', additions: 1, deletions: 1, isBinary: false });

describe('changes tree model', () => {
  it('sorts folders first, compacts chains, and keeps same-basename files distinct', () => {
    const tree = compactChains(buildChangesTree([file('z.ts'), file('a/b/c.ts'), file('x/c.ts')]));
    const rows = flattenRows(tree, defaultExpanded(tree));
    expect(rows.map(row => row.fullPath)).toEqual(['a/b', 'a/b/c.ts', 'x', 'x/c.ts', 'z.ts']);
    expect(rows.filter(row => row.label === 'c.ts')).toHaveLength(2);
    expect(rows[0].changedCount).toBe(1);
  });

  it('reveals ancestors and implements standard navigation plus type-ahead wraparound', () => {
    const tree = buildChangesTree([file('a/one.ts'), file('b/two.ts')]);
    const collapsed = new Set<string>();
    const revealed = revealPath(collapsed, tree, 'b/two.ts');
    expect(revealed.has('d:b')).toBe(true);
    const rows = flattenRows(tree, defaultExpanded(tree));
    expect(navigate(rows, 0, 'End', revealed).activeIndex).toBe(rows.length - 1);
    expect(navigate(rows, 1, 'ArrowUp', revealed).activeIndex).toBe(0);
    expect(typeAhead(rows, rows.length - 1, 'a')).toBe(0);
  });

  it('does not compact across mixed file and folder children', () => {
    const tree = compactChains(buildChangesTree([
      file('a/b/local.ts'),
      file('a/b/c/deep.ts'),
      file('a/b/d/deep.ts'),
    ]));
    const rows = flattenRows(tree, defaultExpanded(tree));

    expect(rows.map(row => row.fullPath)).toEqual([
      'a/b',
      'a/b/c',
      'a/b/c/deep.ts',
      'a/b/d',
      'a/b/d/deep.ts',
      'a/b/local.ts',
    ]);
  });

  it('keeps surviving expansion, defaults new folders open, and preserves recorded collapses', () => {
    const previousTree = compactChains(buildChangesTree([
      file('a/b/c/file.ts'),
      file('collapsed/file.ts'),
    ]));
    const previous = defaultExpanded(previousTree);
    previous.delete('d:collapsed');
    const nextTree = compactChains(buildChangesTree([
      file('a/b/c/file.ts'),
      file('a/b/new.ts'),
      file('collapsed/file.ts'),
      file('new/folder/file.ts'),
    ]));

    const reconciled = reconcileExpanded(previous, nextTree, previousTree);

    expect(reconciled.has('d:a/b')).toBe(true);
    expect(reconciled.has('d:a/b/c')).toBe(true);
    expect(reconciled.has('d:new/folder')).toBe(true);
    expect(reconciled.has('d:collapsed')).toBe(false);
  });

  it('keeps a re-compacted descendant collapsed beneath its prior collapsed ancestor', () => {
    const previousTree = compactChains(buildChangesTree([
      file('a/b/c/one.ts'),
      file('a/b/d/two.ts'),
    ]));
    const previous = defaultExpanded(previousTree);
    previous.delete('d:a/b');
    expect(previous.has('d:a/b/c')).toBe(true);
    const nextTree = compactChains(buildChangesTree([file('a/b/c/one.ts')]));

    const reconciled = reconcileExpanded(previous, nextTree, previousTree);

    expect(nextTree.children[0].id).toBe('d:a/b/c');
    expect(reconciled.has('d:a/b/c')).toBe(false);
  });

  it('preserves expanded descendants when their collapsed ancestor survives an identical refetch', () => {
    const files = [
      file('a/b/c/one.ts'),
      file('a/b/c/two.ts'),
      file('a/b/e/three.ts'),
      file('a/x.ts'),
    ];
    const previousTree = compactChains(buildChangesTree(files));
    const previous = defaultExpanded(previousTree);
    previous.delete('d:a');
    const nextTree = compactChains(buildChangesTree(files));

    const reconciled = reconcileExpanded(previous, nextTree, previousTree);

    expect([...reconciled].sort()).toEqual(['d:a/b', 'd:a/b/c', 'd:a/b/e']);
  });

  it('implements every Left and Right navigation branch', () => {
    const tree = buildChangesTree([file('a/one.ts'), file('a/two.ts'), file('root.ts')]);
    const expanded = defaultExpanded(tree);
    const rows = flattenRows(tree, expanded);

    const collapsed = navigate(rows, 0, 'ArrowLeft', expanded);
    expect(collapsed.activeIndex).toBe(0);
    expect(collapsed.expandedPatch?.has('d:a')).toBe(false);

    const reexpanded = navigate(rows, 0, 'ArrowRight', collapsed.expandedPatch ?? new Set());
    expect(reexpanded.activeIndex).toBe(0);
    expect(reexpanded.expandedPatch?.has('d:a')).toBe(true);

    expect(navigate(rows, 0, 'ArrowRight', expanded).activeIndex).toBe(1);
    expect(navigate(rows, 1, 'ArrowLeft', expanded).activeIndex).toBe(0);
    expect(navigate(rows, rows.length - 1, 'ArrowLeft', expanded).activeIndex).toBe(rows.length - 1);
  });
});
