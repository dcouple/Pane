import type { ChangedFileSummary } from '../../../../../shared/types/gitDiff';

export interface ChangesTreeNode {
  id: string;
  name: string;
  fullPath: string;
  displaySegments: string[];
  kind: 'folder' | 'file';
  children: ChangesTreeNode[];
  file?: ChangedFileSummary;
  changedCount: number;
}

export interface TreeRow {
  id: string;
  depth: number;
  kind: 'folder' | 'file';
  label: string;
  fullPath: string;
  file?: ChangedFileSummary;
  changedCount?: number;
  setSize: number;
  posInSet: number;
}

export interface NavigateResult {
  activeIndex?: number;
  expandedPatch?: Set<string>;
}

const compareNodes = (left: ChangesTreeNode, right: ChangesTreeNode): number => {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  const folded = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  return folded || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
};

export function buildChangesTree(files: ChangedFileSummary[]): ChangesTreeNode {
  const root: ChangesTreeNode = { id: '', name: '', fullPath: '', displaySegments: [], kind: 'folder', children: [], changedCount: 0 };
  for (const file of files) {
    const segments = file.path.split('/');
    let parent = root;
    segments.forEach((segment, index) => {
      const fullPath = segments.slice(0, index + 1).join('/');
      const isFile = index === segments.length - 1;
      let node = parent.children.find(child => child.name === segment && child.kind === (isFile ? 'file' : 'folder'));
      if (!node) {
        node = {
          id: `${isFile ? 'f' : 'd'}:${fullPath}`,
          name: segment,
          fullPath,
          displaySegments: [segment],
          kind: isFile ? 'file' : 'folder',
          children: [],
          file: isFile ? file : undefined,
          changedCount: isFile ? 1 : 0,
        };
        parent.children.push(node);
      }
      parent = node;
    });
  }
  const finalize = (node: ChangesTreeNode): number => {
    node.children.sort(compareNodes);
    if (node.kind === 'file') return 1;
    node.changedCount = node.children.reduce((sum, child) => sum + finalize(child), 0);
    return node.changedCount;
  };
  finalize(root);
  return root;
}

export function compactChains(tree: ChangesTreeNode): ChangesTreeNode {
  const compact = (node: ChangesTreeNode): ChangesTreeNode => {
    const copy = { ...node, displaySegments: [...node.displaySegments], children: node.children.map(compact) };
    if (copy.kind === 'folder') {
      while (copy.children.length === 1 && copy.children[0].kind === 'folder') {
        const child = copy.children[0];
        copy.displaySegments.push(...child.displaySegments);
        copy.fullPath = child.fullPath;
        copy.id = child.id;
        copy.children = child.children;
      }
    }
    return copy;
  };
  return { ...tree, displaySegments: [], children: tree.children.map(compact) };
}

const folderIds = (tree: ChangesTreeNode): string[] => [tree.id, ...tree.children.flatMap(folderIds)].filter(id => id.startsWith('d:'));

export function defaultExpanded(tree: ChangesTreeNode): Set<string> {
  return new Set(folderIds(tree));
}

export function reconcileExpanded(
  previous: ReadonlySet<string>,
  tree: ChangesTreeNode,
  previousTree?: ChangesTreeNode,
): Set<string> {
  const current = new Set(folderIds(tree));
  const prior = new Set(previousTree ? folderIds(previousTree) : []);
  const collapsedPaths: string[] = [];
  for (const id of prior) if (!previous.has(id) && !current.has(id)) collapsedPaths.push(id.slice(2));
  return new Set([...current].filter(id => {
    const path = id.slice(2);
    const belowCollapsedAncestor = collapsedPaths.some(collapsed =>
      path === collapsed || path.startsWith(`${collapsed}/`),
    );
    return !belowCollapsedAncestor && (previous.has(id) || !prior.has(id));
  }));
}

export function flattenRows(tree: ChangesTreeNode, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (children: ChangesTreeNode[], depth: number) => {
    children.forEach((node, index) => {
      rows.push({
        id: node.id,
        depth,
        kind: node.kind,
        label: node.displaySegments.join('/'),
        fullPath: node.fullPath,
        file: node.file,
        changedCount: node.kind === 'folder' ? node.changedCount : undefined,
        setSize: children.length,
        posInSet: index + 1,
      });
      if (node.kind === 'folder' && expanded.has(node.id)) visit(node.children, depth + 1);
    });
  };
  visit(tree.children, 1);
  return rows;
}

export function revealPath(expanded: ReadonlySet<string>, tree: ChangesTreeNode, path: string): Set<string> {
  const next = new Set(expanded);
  const segments = path.split('/');
  for (let index = 1; index < segments.length; index++) next.add(`d:${segments.slice(0, index).join('/')}`);
  for (const id of folderIds(tree)) {
    const canonical = id.slice(2);
    if (path.startsWith(`${canonical}/`)) next.add(id);
  }
  return next;
}

export function navigate(
  rows: TreeRow[],
  activeIndex: number,
  key: string,
  expanded: ReadonlySet<string>,
): NavigateResult {
  if (rows.length === 0) return {};
  const index = Math.max(0, Math.min(activeIndex, rows.length - 1));
  const row = rows[index];
  if (key === 'ArrowDown') return { activeIndex: Math.min(rows.length - 1, index + 1) };
  if (key === 'ArrowUp') return { activeIndex: Math.max(0, index - 1) };
  if (key === 'Home') return { activeIndex: 0 };
  if (key === 'End') return { activeIndex: rows.length - 1 };
  if (key === 'ArrowRight' && row.kind === 'folder') {
    if (!expanded.has(row.id)) return { activeIndex: index, expandedPatch: new Set([...expanded, row.id]) };
    if (rows[index + 1]?.depth > row.depth) return { activeIndex: index + 1 };
  }
  if (key === 'ArrowLeft') {
    if (row.kind === 'folder' && expanded.has(row.id)) {
      const next = new Set(expanded); next.delete(row.id); return { activeIndex: index, expandedPatch: next };
    }
    for (let cursor = index - 1; cursor >= 0; cursor--) if (rows[cursor].depth < row.depth) return { activeIndex: cursor };
  }
  return { activeIndex: index };
}

export function typeAhead(rows: TreeRow[], activeIndex: number, buffer: string): number {
  if (!buffer || rows.length === 0) return activeIndex;
  const query = buffer.toLocaleLowerCase();
  for (let offset = 1; offset <= rows.length; offset++) {
    const index = (Math.max(activeIndex, -1) + offset) % rows.length;
    if (rows[index].label.toLocaleLowerCase().startsWith(query)) return index;
  }
  return activeIndex;
}
