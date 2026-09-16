import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ChangedFileSummary, DiffManifest, DiffScope } from '../../../../../shared/types/gitDiff';
import type { CombinedDiffViewProps, ExecutionDiff } from '../../../types/diff';
import { API } from '../../../utils/api';
import ExecutionList from '../../ExecutionList';
import { CommitDialog } from '../../CommitDialog';
import { editorPanelState, openFileInEditor } from '../../../services/openFileInEditor';
import { usePanelStore } from '../../../stores/panelStore';
import { ChangesTree } from './ChangesTree';
import { buildChangesTree, compactChains, defaultExpanded, reconcileExpanded, revealPath, type ChangesTreeNode } from './changesTreeModel';
import { editorDiffRefForFile, isMutableScope, normalizeEditorDiffRef, sameScope, scopeKey, scopeLabel } from './diffScope';
import { clearPendingViewCommit, takePendingViewCommit } from './pendingViewCommit';

const HISTORY_LIMIT = 50;
const SIDEBAR_STORAGE_KEY = 'diff-panel-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 300;
const MIN_SIDEBAR_WIDTH = 150;
const MAX_SIDEBAR_WIDTH = 600;
const SESSION_SCOPE: DiffScope = { kind: 'session' };
const NO_EXPANSION: ReadonlySet<string> = new Set();

export interface CombinedDiffViewHandle { refresh: () => void }

/** One loaded scope: the request-side scope, its manifest, and the tree derived from it exactly once. */
interface LoadedScope { key: string; scope: DiffScope; manifest: DiffManifest; tree: ChangesTreeNode }

const loadScope = (key: string, scope: DiffScope, manifest: DiffManifest): LoadedScope =>
  ({ key, scope, manifest, tree: compactChains(buildChangesTree(manifest.files)) });

const CombinedDiffView = memo(forwardRef<CombinedDiffViewHandle, CombinedDiffViewProps>(function CombinedDiffView({
  sessionId,
  isGitOperationRunning = false,
  isMainRepo = false,
  isVisible = true,
}, ref) {
  const [executions, setExecutions] = useState<ExecutionDiff[]>([]);
  // The mount site keys this component by session, so per-session state starts fresh on a switch.
  const [scope, setScope] = useState<DiffScope>(SESSION_SCOPE);
  const [display, setDisplay] = useState<LoadedScope | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [mainBranch, setMainBranch] = useState('main');
  const [historySource, setHistorySource] = useState<'remote' | 'local' | 'branch'>(isMainRepo ? 'remote' : 'branch');
  const [expandedByScope, setExpandedByScope] = useState<Record<string, Set<string>>>({});
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    const width = stored ? Number.parseInt(stored, 10) : Number.NaN;
    return Number.isNaN(width) || width < MIN_SIDEBAR_WIDTH || width > MAX_SIDEBAR_WIDTH
      ? DEFAULT_SIDEBAR_WIDTH
      : width;
  });
  const [isResizing, setIsResizing] = useState(false);
  const scopeCache = useRef(new Map<string, LoadedScope>());
  // Survives refresh eviction so a refetched mutable scope can reconcile its expansion state.
  const lastTreeByKey = useRef(new Map<string, ChangesTreeNode>());
  const requestId = useRef(0);
  const executionRequestId = useRef(0);

  const key = `${sessionId}:${scopeKey(scope)}`;
  const expanded = useMemo(() => expandedByScope[key] ?? NO_EXPANSION, [expandedByScope, key]);
  const visible = display?.key === key ? display : null;
  const visibleManifest = visible?.manifest ?? null;
  const loading = loadingKey === key || (visible === null && error === null);

  // Only a diff tab whose scope matches the tree's scope counts as the active file.
  const activeDiffPath = usePanelStore((state) => {
    const activeId = state.activePanels[sessionId];
    const active = (state.panels[sessionId] || []).find(panel => panel.id === activeId);
    const editor = active ? editorPanelState(active) : undefined;
    if (!editor?.diff) return null;
    const normalized = normalizeEditorDiffRef(editor.diff);
    return normalized && sameScope(normalized.scope, scope) ? editor.filePath : null;
  });

  const refresh = useCallback(() => {
    for (const [cacheKey, cached] of scopeCache.current) {
      if (isMutableScope(cached.scope)) scopeCache.current.delete(cacheKey);
    }
    requestId.current += 1;
    setRefreshNonce(value => value + 1);
  }, []);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  // Reveal the active file when it or the scope changes — not on every expansion change,
  // so a folder the user collapses around the open file stays collapsed.
  // Focus returning to the tree reveals explicitly, bypassing that guard.
  const revealedFor = useRef<string | null>(null);
  const revealActiveFile = useCallback(() => {
    if (!activeDiffPath || !visible) return;
    const revealed = revealPath(expanded, visible.tree, activeDiffPath);
    if (revealed.size !== expanded.size) setExpandedByScope(previous => ({ ...previous, [key]: revealed }));
  }, [activeDiffPath, expanded, key, visible]);
  useEffect(() => {
    if (!activeDiffPath || !visible) {
      revealedFor.current = null;
      return;
    }
    const token = `${key}\0${activeDiffPath}`;
    if (revealedFor.current === token) return;
    revealedFor.current = token;
    revealActiveFile();
  }, [activeDiffPath, key, revealActiveFile, visible]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (event: MouseEvent) => {
      const container = document.querySelector('.combined-diff-view');
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      const width = event.clientX - bounds.left;
      // Never persist a width the current host cannot show beside a 240px tree.
      const available = Math.min(MAX_SIDEBAR_WIDTH, bounds.width - 240);
      setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(available, width)));
    };
    const handleMouseUp = () => setIsResizing(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const handleResizeStart = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void API.sessions.getGitCommands(sessionId).then(response => {
      if (cancelled) return;
      if (!response.success || !response.data) return;
      const branch = response.data.originBranch || response.data.comparisonBaseBranch || 'main';
      setMainBranch(branch);
      if (isMainRepo) setHistorySource(response.data.originBranch ? 'remote' : 'local');
    }).catch(cause => {
      if (!cancelled) console.error('Failed to load git commands:', cause);
    });
    return () => { cancelled = true; };
  }, [isMainRepo, sessionId]);

  useEffect(() => {
    if (!isVisible) return;
    const owned = ++executionRequestId.current;
    setExecutionsLoading(true);
    void API.sessions.getExecutions(sessionId).then(response => {
      if (owned !== executionRequestId.current) return;
      if (!response.success) throw new Error(response.error || 'Failed to load commits');
      const data: ExecutionDiff[] = response.data ?? [];
      setExecutions(data);
      const metadata = data.find(execution => execution.comparison_branch || execution.history_source) ?? data[0];
      if (metadata?.comparison_branch) setMainBranch(metadata.comparison_branch);
      if (metadata?.history_source) setHistorySource(metadata.history_source);
    }).catch(cause => {
      if (owned === executionRequestId.current) setError(cause instanceof Error ? cause.message : 'Failed to load commits');
    }).finally(() => {
      if (owned === executionRequestId.current) setExecutionsLoading(false);
    });
  }, [isVisible, refreshNonce, sessionId]);

  useEffect(() => {
    const pending = takePendingViewCommit(sessionId);
    if (pending !== null) setScope(pending === 'index' ? { kind: 'working-tree' } : { kind: 'commit', hash: pending });
    const handler = (event: Event) => {
      // SAFETY: This listener is registered only for the app-owned diff:view-commit event.
      const detail = (event as CustomEvent<{ sessionId: string; commitHash: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      setScope(detail.commitHash === 'index' ? { kind: 'working-tree' } : { kind: 'commit', hash: detail.commitHash });
      clearPendingViewCommit();
    };
    window.addEventListener('diff:view-commit', handler);
    return () => window.removeEventListener('diff:view-commit', handler);
  }, [sessionId, setScope]);

  useEffect(() => {
    if (!isVisible) return;
    const owned = ++requestId.current;
    const cached = scopeCache.current.get(key);
    if (cached) {
      setDisplay(cached);
      setLoadingKey(null);
      setError(null);
      return;
    }
    setLoadingKey(key);
    setError(null);
    void API.sessions.getDiffManifest(sessionId, scope).then(response => {
      if (owned !== requestId.current) return;
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to load changes');
      const loaded = loadScope(key, scope, response.data);
      scopeCache.current.set(key, loaded);
      const previousTree = lastTreeByKey.current.get(key);
      lastTreeByKey.current.set(key, loaded.tree);
      setDisplay(loaded);
      setExpandedByScope(previous => ({
        ...previous,
        [key]: previous[key] ? reconcileExpanded(previous[key], loaded.tree, previousTree) : defaultExpanded(loaded.tree),
      }));
    }).catch(cause => {
      if (owned === requestId.current) setError(cause instanceof Error ? cause.message : 'Failed to load changes');
    }).finally(() => {
      if (owned === requestId.current) setLoadingKey(null);
    });
  }, [isVisible, key, refreshNonce, scope, sessionId]);

  const selection = useMemo((): { kind: 'all' } | { kind: 'ids'; ids: number[] } => {
    if (scope.kind === 'session') return { kind: 'all' };
    if (scope.kind === 'working-tree') return { kind: 'ids', ids: [0] };
    const byHash = new Map(executions.map(execution => [execution.after_commit_hash, execution.id]));
    if (scope.kind === 'commit') {
      const match = executions.find(execution =>
        execution.after_commit_hash === scope.hash || execution.after_commit_hash?.startsWith(scope.hash) === true,
      );
      return { kind: 'ids', ids: match ? [match.id] : [] };
    }
    if (scope.kind === 'commit-range') return { kind: 'ids', ids: [byHash.get(scope.olderHash), byHash.get(scope.newerHash)].filter((id): id is number => id !== undefined) };
    return { kind: 'ids', ids: [0, byHash.get(scope.baseHash)].filter((id): id is number => id !== undefined) };
  }, [executions, scope]);

  const selectIds = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    const byId = new Map(executions.map(execution => [execution.id, execution]));
    if (ids.length === 1) {
      const id = ids[0];
      if (id === 0) setScope({ kind: 'working-tree' });
      else {
        const hash = byId.get(id)?.after_commit_hash;
        if (hash) setScope({ kind: 'commit', hash });
      }
      return;
    }
    if (ids.includes(0)) {
      const commitId = ids.find(id => id !== 0);
      const hash = commitId === undefined ? undefined : byId.get(commitId)?.after_commit_hash;
      if (hash) setScope({ kind: 'working-tree-range', baseHash: hash });
      return;
    }
    const olderId = Math.max(...ids);
    const newerId = Math.min(...ids);
    const olderHash = byId.get(olderId)?.after_commit_hash;
    const newerHash = byId.get(newerId)?.after_commit_hash;
    if (olderHash && newerHash) setScope({ kind: 'commit-range', olderHash, newerHash });
  }, [executions, setScope]);

  const handleFileOpen = useCallback((file: ChangedFileSummary, pin: boolean) => {
    void openFileInEditor({ sessionId, filePath: file.path, pin, diff: editorDiffRefForFile(scope, file) });
  }, [scope, sessionId]);

  const handleCommit = useCallback(async (message: string) => {
    const response = await window.electronAPI.invoke('git:commit', { sessionId, message });
    if (!response.success) throw new Error(response.error || 'Failed to commit changes');
    refresh();
  }, [refresh, sessionId]);

  const handleRevert = useCallback(async (commitHash: string) => {
    if (!window.confirm(`Revert commit ${commitHash.slice(0, 7)}?`)) return;
    const response = await window.electronAPI.invoke('git:revert', { sessionId, commitHash });
    if (!response.success) throw new Error(response.error || 'Failed to revert commit');
    refresh();
  }, [refresh, sessionId]);

  const handleRestore = useCallback(async () => {
    if (!window.confirm('Restore all uncommitted changes?')) return;
    const response = await window.electronAPI.invoke('git:restore', { sessionId });
    if (!response.success) throw new Error(response.error || 'Failed to restore changes');
    refresh();
  }, [refresh, sessionId]);

  const label = scopeLabel(scope, { ref: visibleManifest?.resolvedBase.ref });
  const historyLabel = isMainRepo ? (historySource === 'local' ? 'Local commits' : mainBranch) : null;
  const headerLabel = historyLabel ? `${historyLabel} · ${label}` : label;
  const busy = loading || executionsLoading || isGitOperationRunning;
  const historyLimitReached = executions.some(execution => execution.history_limit_reached);
  const emptyMessage = isMainRepo && executions.length === 0
    ? historySource === 'remote'
      ? `No commits ahead of ${mainBranch}`
      : 'Origin remote not found; showing recent local commits'
    : 'No changes to review';

  return (
    <div className="combined-diff-view flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-primary bg-surface-secondary px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium text-text-secondary">{headerLabel}</span>
          {visibleManifest && <div className="flex flex-shrink-0 items-center gap-2 text-xs"><span className="font-semibold text-status-success">+{visibleManifest.stats.additions}</span><span className="font-semibold text-status-error">-{visibleManifest.stats.deletions}</span><span className="text-text-muted">{visibleManifest.stats.filesChanged}f</span></div>}
        </div>
        <button type="button" onClick={refresh} disabled={busy} className="rounded p-1 hover:bg-surface-hover" title="Refresh"><RefreshCw className={`h-3.5 w-3.5 text-text-tertiary ${busy ? 'animate-spin' : ''}`} /></button>
      </div>
      <div className="pane-review-split flex min-h-0 flex-1">
        <div className="pane-review-list flex flex-shrink-0 flex-col overflow-hidden border-r border-border-primary bg-surface-secondary" style={{ width: sidebarWidth }}>
          <ExecutionList sessionId={sessionId} executions={executions} selection={selection} onSelectAll={() => setScope({ kind: 'session' })} onSelectionChange={selectIds} onCommit={() => setShowCommitDialog(true)} onRevert={handleRevert} onRestore={handleRestore} historyLimitReached={historyLimitReached} historyLimit={HISTORY_LIMIT} />
        </div>
        <div className="pane-review-handle w-1 flex-shrink-0 cursor-col-resize bg-transparent" onMouseDown={handleResizeStart} title="Drag to resize sidebar" />
        <div className="diff-panel flex min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary">
          {isGitOperationRunning ? (
            <div className="flex h-full flex-col items-center justify-center p-8">
              <RefreshCw className="mb-4 h-12 w-12 animate-spin text-interactive" />
              <div className="text-center text-text-secondary">
                <p className="font-medium">Git operation in progress</p>
                <p className="mt-1 text-sm text-text-tertiary">Please wait while the operation completes...</p>
              </div>
            </div>
          ) : loading && !visibleManifest ? <div className="animate-pulse p-4 text-sm text-text-secondary">Loading {label}…</div>
            : error ? <div role="alert" className="m-4 rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">{error}</div>
              : visible && visible.manifest.files.length > 0 ? <ChangesTree sessionId={sessionId} tree={visible.tree} scopeKey={scopeKey(scope)} activePath={activeDiffPath} expanded={expanded} onExpandedChange={next => setExpandedByScope(previous => ({ ...previous, [key]: next }))} onRevealActive={revealActiveFile} onFileOpen={handleFileOpen} />
                : <div className="flex h-full items-center justify-center text-sm text-text-secondary"><div className="space-y-2 text-center"><p>{emptyMessage}</p>{isMainRepo && historySource === 'remote' && <p className="text-sm text-text-tertiary">Create new commits to see them here.</p>}</div></div>}
        </div>
      </div>
      <CommitDialog isOpen={showCommitDialog} onClose={() => setShowCommitDialog(false)} onCommit={handleCommit} fileCount={visibleManifest?.stats.filesChanged ?? 0} />
    </div>
  );
}));

CombinedDiffView.displayName = 'CombinedDiffView';
export default CombinedDiffView;
