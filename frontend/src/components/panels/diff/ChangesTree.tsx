import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import type { ChangedFileSummary } from '../../../../../shared/types/gitDiff';
import { cn } from '../../../utils/cn';
import { useScrollSurface } from '../../../hooks/useScrollSurface';
import { flattenRows, navigate, typeAhead, type ChangesTreeNode } from './changesTreeModel';

const ROW_HEIGHT = 32;
const OVERSCAN = 8;

const statusLabel = (file: ChangedFileSummary): string => {
  if (file.kind === 'renamed') return `Renamed from ${file.previousPath ?? 'unknown path'}`;
  return `${file.kind[0].toUpperCase()}${file.kind.slice(1)}`;
};

const accessibleFileLabel = (file: ChangedFileSummary): string => {
  const additions = file.additions === null ? 'additions unavailable' : `+${file.additions}`;
  const deletions = file.deletions === null ? 'deletions unavailable' : `−${file.deletions}`;
  return `Open diff for ${file.path}, ${statusLabel(file)}, ${additions} ${deletions}`;
};

export const ChangesTree = memo(function ChangesTree({
  sessionId,
  tree,
  scopeKey,
  activePath,
  expanded,
  onExpandedChange,
  onRevealActive,
  onFileOpen,
}: {
  sessionId: string;
  tree: ChangesTreeNode;
  scopeKey: string;
  activePath: string | null;
  expanded: ReadonlySet<string>;
  onExpandedChange: (expanded: Set<string>) => void;
  /** Asks the owner to expand the active file's ancestors (focus returning to the tree). */
  onRevealActive: () => void;
  onFileOpen: (file: ChangedFileSummary, pin: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const typeBuffer = useRef('');
  const typeTimer = useRef<number | null>(null);
  const rows = useMemo(() => flattenRows(tree, expanded), [tree, expanded]);
  const treeId = useMemo(() => `changes-tree-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`, [scopeKey, sessionId]);
  const ownerElement = useCallback(() => hostRef.current, []);
  const registerScrollSurface = useScrollSurface<HTMLDivElement>({ id: `diff:${sessionId}`, sessionId, priority: 90, ownerElement });
  const setHostElement = useCallback((element: HTMLDivElement | null) => {
    hostRef.current = element;
    registerScrollSurface(element);
  }, [registerScrollSurface]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setHeight(host.clientHeight));
    observer.observe(host);
    setHeight(host.clientHeight);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    // SAFETY: The optional flag is installed only by the Playwright mock; absence is valid in production.
    const perfWindow = window as typeof window & { __paneTestPerf?: boolean };
    if (!perfWindow.__paneTestPerf) return;
    if (performance.getEntriesByName('pane-diff-manifest-received').length === 0) return;
    performance.mark('pane-diff-tree-committed');
    requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('pane-diff-tree-painted')));
  }, [rows.length]);

  useEffect(() => {
    if (!activePath) return;
    const index = rows.findIndex(row => row.file?.path === activePath);
    if (index >= 0) setActiveIndex(index);
  }, [activePath, rows]);

  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleEnd = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const indexes = new Set(Array.from({ length: Math.max(0, visibleEnd - visibleStart) }, (_, offset) => visibleStart + offset));
  if (rows[activeIndex]) indexes.add(activeIndex);

  const scrollToIndex = (index: number) => {
    const host = hostRef.current;
    if (!host) return;
    const top = index * ROW_HEIGHT;
    if (top < host.scrollTop) host.scrollTop = top;
    else if (top + ROW_HEIGHT > host.scrollTop + host.clientHeight) host.scrollTop = top + ROW_HEIGHT - host.clientHeight;
  };

  const activate = (index: number) => { setActiveIndex(index); scrollToIndex(index); };
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    onExpandedChange(next);
  };

  return (
    <div
      ref={setHostElement}
      role="tree"
      tabIndex={0}
      aria-label="Changed files"
      aria-activedescendant={rows[activeIndex] ? `${treeId}-r${activeIndex}` : undefined}
      className="pane-changes-tree min-h-0 flex-1 overflow-auto outline-none"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onFocus={() => {
        if (!activePath) return;
        const index = rows.findIndex(row => row.file?.path === activePath);
        if (index >= 0) activate(index); else onRevealActive();
      }}
      onKeyDown={(event) => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const result = navigate(rows, activeIndex, event.key, expanded);
          if (result.expandedPatch) onExpandedChange(result.expandedPatch);
          if (result.activeIndex !== undefined) activate(result.activeIndex);
          return;
        }
        const row = rows[activeIndex];
        if ((event.key === 'Enter' || event.key === ' ') && row) {
          event.preventDefault();
          if (row.kind === 'folder') toggle(row.id); else if (row.file) onFileOpen(row.file, false);
          return;
        }
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          typeBuffer.current += event.key;
          activate(typeAhead(rows, activeIndex, typeBuffer.current));
          if (typeTimer.current !== null) window.clearTimeout(typeTimer.current);
          typeTimer.current = window.setTimeout(() => { typeBuffer.current = ''; }, 700);
        }
      }}
    >
      <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
        {[...indexes].sort((a, b) => a - b).map(index => {
          const row = rows[index];
          const selected = row.file?.path === activePath;
          const active = index === activeIndex;
          const label = row.file ? accessibleFileLabel(row.file) : row.label;
          return (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Keyboard interaction is delegated to the focusable tree container.
            <div
              id={`${treeId}-r${index}`}
              key={row.id}
              role="treeitem"
              aria-label={label}
              aria-level={row.depth}
              aria-setsize={row.setSize}
              aria-posinset={row.posInSet}
              aria-expanded={row.kind === 'folder' ? expanded.has(row.id) : undefined}
              aria-selected={row.kind === 'file' ? selected : undefined}
              aria-current={selected ? 'true' : undefined}
              className={cn('pane-changes-tree-row absolute left-0 right-0', active && 'is-active', selected && 'is-selected')}
              style={{ top: index * ROW_HEIGHT, paddingLeft: row.depth * 16 + 8 }}
              title={row.file?.previousPath ? `${row.file.previousPath} → ${row.fullPath}` : row.fullPath}
              onClick={() => { activate(index); if (row.kind === 'folder') toggle(row.id); else if (row.file) onFileOpen(row.file, false); }}
              onDoubleClick={() => { if (row.file) onFileOpen(row.file, true); }}
            >
              <span className="pane-changes-tree-twistie">{row.kind === 'folder' && <ChevronRight className={cn('h-3.5 w-3.5', expanded.has(row.id) && 'rotate-90')} />}</span>
              {row.kind === 'folder' ? <Folder className="h-3.5 w-3.5 text-text-tertiary" /> : <FileText className="h-3.5 w-3.5 text-text-tertiary" />}
              <span className="pane-changes-tree-label"><bdi>{row.label}</bdi></span>
              {row.file ? (
                <>
                  <span className="pane-changes-tree-stats">{row.file.additions === null ? '—' : `+${row.file.additions}`} {row.file.deletions === null ? '—' : `−${row.file.deletions}`}</span>
                  <span className="pane-changes-tree-status" aria-hidden="true">{row.file.kind[0].toUpperCase()}</span>
                  <span className="sr-only">{statusLabel(row.file)}</span>
                </>
              ) : <span className="pane-changes-tree-count" aria-label={`${row.changedCount} changed files`}>{row.changedCount}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
});
