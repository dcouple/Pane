import React, { useState, useEffect, memo, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from 'react';
import DiffViewer, { DiffViewerHandle } from './DiffViewer';
import ExecutionList from '../../ExecutionList';
import { CommitDialog } from '../../CommitDialog';
import { API } from '../../../utils/api';
import type { CombinedDiffViewProps, FileDiff } from '../../../types/diff';
import type { ExecutionDiff, GitDiffResult } from '../../../types/diff';
import { RefreshCw } from 'lucide-react';
import { panelApi } from '../../../services/panelApi';
import { usePanelStore } from '../../../stores/panelStore';

const HISTORY_LIMIT = 50;

const SIDEBAR_STORAGE_KEY = 'diff-panel-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 300;
const MIN_SIDEBAR_WIDTH = 150;
const MAX_SIDEBAR_WIDTH = 600;

// --- Unified diff parser (single pass, shared between FileList and DiffViewer) ---

function parseUnifiedDiffToFiles(diff: string): FileDiff[] {
  if (!diff?.trim()) return [];

  const fileChunks = diff.match(/diff --git[\s\S]*?(?=diff --git|$)/g);
  if (!fileChunks) return [];

  return fileChunks.flatMap(chunk => {
    const nameMatch = chunk.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/);
    if (!nameMatch) return [];
    const oldPath = nameMatch[1];
    const newPath = nameMatch[2];
    const isBinary = chunk.includes('Binary files') || chunk.includes('GIT binary patch');

    let type: FileDiff['type'] = 'modified';
    if (chunk.includes('new file mode')) type = 'added';
    else if (chunk.includes('deleted file mode')) type = 'deleted';
    else if (chunk.includes('rename from') && chunk.includes('rename to')) type = 'renamed';

    const additions = (chunk.match(/^\+(?!\+\+)/gm) || []).length;
    const deletions = (chunk.match(/^-(?!--)/gm) || []).length;

    return [{ path: newPath || oldPath, oldPath, type, isBinary, additions, deletions, rawDiff: chunk }];
  });
}

// --- CombinedDiffView ---

export interface CombinedDiffViewHandle {
  refresh: () => void;
}

const CombinedDiffView = memo(forwardRef<CombinedDiffViewHandle, CombinedDiffViewProps>(({
  sessionId,
  selectedExecutions: initialSelected,
  isGitOperationRunning = false,
  isMainRepo = false,
  isVisible = true,
}, ref) => {
  const addPanel = usePanelStore((state) => state.addPanel);
  const setActivePanelInStore = usePanelStore((state) => state.setActivePanel);
  const [executions, setExecutions] = useState<ExecutionDiff[]>([]);
  const [selectedExecutions, setSelectedExecutions] = useState<number[]>(initialSelected);
  const [lastSessionId, setLastSessionId] = useState<string>(sessionId);
  const [combinedDiff, setCombinedDiff] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [mainBranch, setMainBranch] = useState<string>('main');
  const [historySource, setHistorySource] = useState<'remote' | 'local' | 'branch'>(isMainRepo ? 'remote' : 'branch');
  const [forceRefresh, setForceRefresh] = useState<number>(0);

  // Diff cache: keyed by sessionId + sorted selection
  const diffCacheRef = useRef<Map<string, { diff: GitDiffResult; parsedFiles: FileDiff[] }>>(new Map());

  // Resizable sidebar state
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored) {
      const width = parseInt(stored, 10);
      if (!isNaN(width) && width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH) {
        return width;
      }
    }
    return DEFAULT_SIDEBAR_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);

  const diffViewerRef = useRef<DiffViewerHandle>(null);
  // Track diff-relevant git state to avoid spurious prefetches on no-op status events
  const lastGitFingerprintRef = useRef<string>('');

  // Expose refresh() to parent (DiffPanel) via ref
  // Keeps current diff visible while new data loads (no flash),
  // but resets selection since execution IDs are positional and
  // may point to different commits after history changes.
  useImperativeHandle(ref, () => ({
    refresh: () => {
      diffCacheRef.current.clear();
      setSelectedExecutions([]);
      setForceRefresh(prev => prev + 1);
    }
  }));

  // Save sidebar width to localStorage
  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  // Handle resize mouse events
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = document.querySelector('.combined-diff-view');
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const newWidth = e.clientX - containerRect.left;
      const constrainedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, newWidth));
      setSidebarWidth(constrainedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

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

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  // Load git commands to get main branch
  useEffect(() => {
    const loadGitCommands = async () => {
      try {
        const response = await API.sessions.getGitCommands(sessionId);
        if (response.success && response.data) {
          const baseBranch = response.data.originBranch || response.data.mainBranch || 'main';
          setMainBranch(baseBranch);
          if (isMainRepo) {
            setHistorySource(response.data.originBranch ? 'remote' : 'local');
          }
        }
      } catch (err) {
        console.error('Failed to load git commands:', err);
      }
    };

    loadGitCommands();
  }, [sessionId, isMainRepo]);

  // Reset selection when session changes
  useEffect(() => {
    if (sessionId !== lastSessionId) {
      setSelectedExecutions([]);
      setLastSessionId(sessionId);
      setCombinedDiff(null);
      setExecutions([]);
      setHistorySource(isMainRepo ? 'remote' : 'branch');
      diffCacheRef.current.clear();
      lastGitFingerprintRef.current = '';
    }
  }, [sessionId, lastSessionId, isMainRepo]);

  // Shared logic to process loaded executions
  const processExecutions = useCallback((data: ExecutionDiff[], autoSelect: boolean) => {
    setError(null);
    setExecutions(data);

    if (data.length > 0) {
      const metadata = data.find(exec => exec.comparison_branch || exec.history_source) || data[0];
      if (metadata?.comparison_branch) {
        setMainBranch(metadata.comparison_branch);
      }
      if (metadata?.history_source) {
        setHistorySource(metadata.history_source);
      } else {
        setHistorySource(isMainRepo ? 'remote' : 'branch');
      }
    } else {
      setHistorySource(prev => {
        if (isMainRepo) {
          return prev;
        }
        return 'branch';
      });
    }

    // Auto-select executions when no selection exists or when prefetching
    if (autoSelect && data.length > 0) {
      const allCommitIds = data
        .filter((exec: ExecutionDiff) => exec.id !== 0)
        .map((exec: ExecutionDiff) => exec.id);

      if (allCommitIds.length > 0) {
        setSelectedExecutions([allCommitIds[allCommitIds.length - 1], allCommitIds[0]]);
      } else {
        setSelectedExecutions(data.map((exec: ExecutionDiff) => exec.id));
      }
    }
  }, [isMainRepo]);

  // Load executions for the session (skip when panel is not visible)
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;

    const timeoutId = setTimeout(() => {
      const loadExecutions = async () => {
        try {
          setLoading(true);
          const response = await API.sessions.getExecutions(sessionId);

          if (cancelled) return;

          if (!response.success) {
            throw new Error(response.error || 'Failed to load executions');
          }
          const data: ExecutionDiff[] = response.data || [];
          processExecutions(data, selectedExecutions.length === 0);
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Failed to load executions');
          }
        } finally {
          if (!cancelled) {
            setLoading(false);
          }
        }
      };

      loadExecutions();
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedExecutions read inside closure to check if auto-select needed; must not re-trigger on selection change
  }, [sessionId, isMainRepo, forceRefresh, isVisible, processExecutions]);

  // Background prefetch: when git status changes, fetch executions + diff even when not visible
  // This ensures the diff tab has data ready before the user opens it
  useEffect(() => {
    let cancelled = false;

    const handleGitStatusUpdated = (event: Event) => {
      const { sessionId: eventSessionId, gitStatus } = (event as CustomEvent).detail || {};
      if (eventSessionId !== sessionId) return;

      // Fingerprint diff-relevant fields — ignore no-op status refreshes
      const fingerprint = `${gitStatus?.state}-${gitStatus?.ahead}-${gitStatus?.behind}-${gitStatus?.uncommittedChanges}`;
      if (fingerprint === lastGitFingerprintRef.current) return;
      lastGitFingerprintRef.current = fingerprint;

      // Clear stale cache and force diff re-fetch for existing selection
      diffCacheRef.current.clear();
      setForceRefresh(prev => prev + 1);

      // Prefetch executions and let the diff loading effect chain handle the rest
      // Only auto-select if user hasn't made a custom selection (preserves their commit range)
      API.sessions.getExecutions(sessionId).then(response => {
        if (cancelled || !response.success) return;
        const data: ExecutionDiff[] = response.data || [];
        processExecutions(data, selectedExecutionsRef.current.length === 0);
      }).catch(() => { /* silent — prefetch is best-effort */ });
    };

    window.addEventListener('git-status-updated', handleGitStatusUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('git-status-updated', handleGitStatusUpdated);
    };
  }, [sessionId, processExecutions]);

  // Keep refs to avoid stale closures in event handlers
  const executionsLengthRef = useRef(executions.length);
  executionsLengthRef.current = executions.length;
  const selectedExecutionsRef = useRef(selectedExecutions);
  selectedExecutionsRef.current = selectedExecutions;

  // Load combined diff when selection changes (with caching)
  useEffect(() => {
    let cancelled = false;

    const timeoutId = setTimeout(() => {
      const loadCombinedDiff = async () => {
        if (selectedExecutions.length === 0) {
          setCombinedDiff(null);
          return;
        }

        // Check cache first
        const cacheKey = `${sessionId}-${JSON.stringify(selectedExecutions.slice().sort((a, b) => a - b))}`;
        const cached = diffCacheRef.current.get(cacheKey);
        if (cached) {
          setCombinedDiff(cached.diff);
          setLoading(false);
          setError(null);
          return;
        }

        try {
          setLoading(true);
          setError(null);

          let response;
          if (selectedExecutions.length === 1) {
            if (selectedExecutions[0] === 0) {
              response = await API.sessions.getCombinedDiff(sessionId, [0]);
            } else {
              response = await API.sessions.getCombinedDiff(sessionId, [selectedExecutions[0], selectedExecutions[0]]);
            }
          } else if (selectedExecutions.length === executionsLengthRef.current) {
            response = await API.sessions.getCombinedDiff(sessionId);
          } else {
            response = await API.sessions.getCombinedDiff(sessionId, selectedExecutions);
          }

          if (cancelled) return;

          if (!response.success) {
            throw new Error(response.error || 'Failed to load combined diff');
          }

          const data = response.data;
          setCombinedDiff(data);

          // Store in cache
          if (data) {
            const parsedFiles = parseUnifiedDiffToFiles(data.diff);
            diffCacheRef.current.set(cacheKey, { diff: data, parsedFiles });
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Failed to load combined diff');
            setCombinedDiff(null);
          }
        } finally {
          if (!cancelled) {
            setLoading(false);
          }
        }
      };

      loadCombinedDiff();
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executions.length read via ref to avoid re-triggering when executions reload
  }, [selectedExecutions, sessionId, forceRefresh]);

  const handleSelectionChange = (newSelection: number[]) => {
    setSelectedExecutions(newSelection);
  };

  const handleManualRefresh = () => {
    diffCacheRef.current.clear();
    setForceRefresh(prev => prev + 1);
    setCombinedDiff(null);
    setSelectedExecutions([]);
  };

  const handleCommit = useCallback(async (message: string) => {
    const result = await window.electronAPI.invoke('git:commit', {
      sessionId,
      message
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to commit changes');
    }

    // Invalidate cache and reload to reflect the new commit
    diffCacheRef.current.clear();
    setCombinedDiff(null);
    const response = await API.sessions.getExecutions(sessionId);
    if (response.success) {
      setExecutions(response.data);
    }
  }, [sessionId]);

  const handleRevert = useCallback(async (commitHash: string) => {
    if (!window.confirm(`Are you sure you want to revert commit ${commitHash.substring(0, 7)}? This will create a new commit that undoes the changes.`)) {
      return;
    }

    try {
      const result = await window.electronAPI.invoke('git:revert', {
        sessionId,
        commitHash
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to revert commit');
      }

      const response = await API.sessions.getExecutions(sessionId);
      if (response.success) {
        setExecutions(response.data);
        setSelectedExecutions([]);
      }
    } catch (err) {
      console.error('Error reverting commit:', err);
      alert(`Failed to revert commit: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [sessionId]);

  const limitReached = useMemo(
    () => executions.some(exec => exec.history_limit_reached),
    [executions]
  );

  // Parse files from diff for DiffViewer
  const parsedFiles = useMemo(() => {
    if (!combinedDiff?.diff) return [];
    return parseUnifiedDiffToFiles(combinedDiff.diff);
  }, [combinedDiff]);

  const handleRestore = useCallback(async () => {
    if (!window.confirm('Are you sure you want to restore all uncommitted changes? This will discard all your local modifications.')) {
      return;
    }

    try {
      const result = await window.electronAPI.invoke('git:restore', {
        sessionId
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to restore changes');
      }

      // Reload executions and diff
      const response = await API.sessions.getExecutions(sessionId);
      if (response.success) {
        setExecutions(response.data);
      }

      // Reload the uncommitted changes diff if selected
      diffCacheRef.current.clear();
      if (selectedExecutions.includes(0)) {
        const diffResponse = await API.sessions.getCombinedDiff(sessionId, [0]);
        if (diffResponse.success) {
          setCombinedDiff(diffResponse.data);
        }
      }
    } catch (err) {
      console.error('Error restoring changes:', err);
      alert(`Failed to restore changes: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [sessionId, selectedExecutions]);

  // Open file in an Explorer (editor) panel
  const handleOpenInEditor = useCallback(async (filePath: string) => {
    const filename = filePath.split(/[/\\]/).pop() || 'Editor';
    const newPanel = await panelApi.createPanel({
      sessionId,
      type: 'explorer',
      title: filename,
      initialState: {
        customState: { filePath },
      },
    });
    addPanel(newPanel);
    setActivePanelInStore(sessionId, newPanel.id);
    await panelApi.setActivePanel(sessionId, newPanel.id);
  }, [sessionId, addPanel, setActivePanelInStore]);

  if (loading && executions.length === 0) {
    return (
      <div className="flex flex-col h-full animate-pulse">
        {/* Header skeleton */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-primary bg-surface-secondary">
          <div className="h-3 w-24 bg-surface-tertiary rounded" />
          <div className="h-3.5 w-3.5 bg-surface-tertiary rounded" />
        </div>
        <div className="flex-1 flex min-h-0">
          {/* Sidebar skeleton */}
          <div className="w-52 border-r border-border-primary bg-surface-secondary p-2 space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-10 bg-surface-tertiary rounded" />
            ))}
          </div>
          {/* Diff area skeleton */}
          <div className="flex-1 p-4 space-y-3">
            <div className="h-4 w-48 bg-surface-tertiary rounded" />
            <div className="h-3 w-full bg-surface-tertiary rounded" />
            <div className="h-3 w-3/4 bg-surface-tertiary rounded" />
            <div className="h-3 w-5/6 bg-surface-tertiary rounded" />
            <div className="h-3 w-2/3 bg-surface-tertiary rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (error && executions.length === 0) {
    return (
      <div className="p-4 text-status-error bg-status-error/10 border border-status-error/30 rounded">
        <h3 className="font-medium mb-2">Error</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="combined-diff-view flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-primary bg-surface-secondary">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-text-secondary truncate">
            {isMainRepo
              ? historySource === 'local'
                ? 'Local commits'
                : mainBranch
              : 'Changes'}
          </span>
          {combinedDiff && (
            <div className="flex items-center gap-2 text-xs flex-shrink-0">
              <span className="text-status-success font-semibold">+{combinedDiff.stats.additions}</span>
              <span className="text-status-error font-semibold">-{combinedDiff.stats.deletions}</span>
              <span className="text-text-muted">{combinedDiff.stats.filesChanged}f</span>
            </div>
          )}
          {isGitOperationRunning && (
            <RefreshCw className="w-3 h-3 text-interactive animate-spin flex-shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleManualRefresh}
            className="p-1 rounded hover:bg-surface-hover transition-colors"
            title="Refresh"
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 text-text-tertiary ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Commits selection sidebar */}
            <div
              className="border-r border-border-primary bg-surface-secondary overflow-hidden flex flex-col flex-shrink-0"
              style={{ width: sidebarWidth }}
            >
              {/* Execution list */}
              <div className="h-full">
                <ExecutionList
                  sessionId={sessionId}
                  executions={executions}
                  selectedExecutions={selectedExecutions}
                  onSelectionChange={handleSelectionChange}
                  onCommit={() => setShowCommitDialog(true)}
                  onRevert={handleRevert}
                  onRestore={handleRestore}
                  historyLimitReached={limitReached}
                  historyLimit={HISTORY_LIMIT}
                />
              </div>
            </div>

            {/* Resize handle */}
            <div
              className={`w-1 hover:bg-interactive cursor-col-resize flex-shrink-0 transition-colors ${
                isResizing ? 'bg-interactive' : 'bg-transparent'
              }`}
              onMouseDown={handleResizeStart}
              title="Drag to resize sidebar"
            />
        {/* Diff preview */}
        <div className="flex-1 overflow-auto bg-bg-primary min-w-0 flex flex-col">
          {isGitOperationRunning ? (
            <div className="flex flex-col items-center justify-center h-full p-8">
              <svg className="animate-spin h-12 w-12 text-interactive mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <div className="text-text-secondary text-center">
                <p className="font-medium">Git operation in progress</p>
                <p className="text-sm text-text-tertiary mt-1">Please wait while the operation completes...</p>
              </div>
            </div>
          ) : loading && combinedDiff === null ? (
            <div className="animate-pulse p-4 space-y-3">
              <div className="h-4 w-48 bg-surface-tertiary rounded" />
              <div className="h-3 w-full bg-surface-tertiary rounded" />
              <div className="h-3 w-3/4 bg-surface-tertiary rounded" />
              <div className="h-3 w-5/6 bg-surface-tertiary rounded" />
            </div>
          ) : error ? (
            <div className="p-4 text-status-error bg-status-error/10 border border-status-error/30 rounded m-4">
              <h3 className="font-medium mb-2">Error loading diff</h3>
              <p>{error}</p>
            </div>
          ) : combinedDiff ? (
            <DiffViewer
              ref={diffViewerRef}
              files={parsedFiles}
              sessionId={sessionId}
              className="h-full"
              onOpenInEditor={handleOpenInEditor}
            />
          ) : executions.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-secondary">
              <div className="text-center space-y-2">
                <p>
                  {isMainRepo
                    ? historySource === 'remote'
                      ? `No commits ahead of ${mainBranch}`
                      : 'Origin remote not found; showing recent local commits'
                    : 'No commits found for this session'}
                </p>
                {isMainRepo && historySource === 'remote' && (
                  <p className="text-sm text-text-tertiary">
                    Create new commits to see them here.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-text-secondary">
              Select commits to view changes
            </div>
          )}
        </div>
      </div>

      {/* Commit Dialog */}
      <CommitDialog
        isOpen={showCommitDialog}
        onClose={() => setShowCommitDialog(false)}
        onCommit={handleCommit}
        fileCount={combinedDiff?.stats.filesChanged || 0}
      />
    </div>
  );
}), (prevProps, nextProps) => {
  return (
    prevProps.sessionId === nextProps.sessionId &&
    prevProps.isGitOperationRunning === nextProps.isGitOperationRunning &&
    prevProps.isMainRepo === nextProps.isMainRepo &&
    prevProps.isVisible === nextProps.isVisible &&
    prevProps.selectedExecutions.length === nextProps.selectedExecutions.length &&
    prevProps.selectedExecutions.every((val, idx) => val === nextProps.selectedExecutions[idx])
  );
});

CombinedDiffView.displayName = 'CombinedDiffView';

export default CombinedDiffView;
