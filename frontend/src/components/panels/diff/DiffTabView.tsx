import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import type { DiffHighlighter } from '@git-diff-view/shiki';
import { ExternalLink, FileDiff as FileDiffIcon, RefreshCw } from 'lucide-react';
import type { EditorDiffRef } from '../../../../../shared/types/panels';
import type { FileDiff } from '../../../types/diff';
import { isLightTheme, useTheme } from '../../../contexts/ThemeContext';
import { openFileInEditor } from '../../../services/openFileInEditor';
import { diffRefLabel, getShikiHighlighter, isWorkingTreeRef, loadDiffForRef, parseUnifiedDiffToFiles } from './diffSource';
import '@git-diff-view/react/styles/diff-view.css';

interface DiffTabViewProps {
  sessionId: string;
  filePath: string;
  diffRef: EditorDiffRef;
}

const REFRESH_EVENTS = new Set(['git:operation_completed', 'diff:refreshed', 'terminal:command_executed', 'files:changed']);

function readViewType(): DiffModeEnum {
  return localStorage.getItem('diffViewType') === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified;
}

/** One file's diff as a center tab, addressed by the Review panel's ref. */
export function DiffTabView({ sessionId, filePath, diffRef }: DiffTabViewProps) {
  const { theme } = useTheme();
  const isDarkMode = !isLightTheme(theme);
  const [file, setFile] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlighter, setHighlighter] = useState<DiffHighlighter | null>(null);
  const [viewType, setViewType] = useState<DiffModeEnum>(readViewType);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    getShikiHighlighter().then(setHighlighter);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadDiffForRef(sessionId, diffRef)
      .then((result) => {
        if (cancelled) return;
        const files = parseUnifiedDiffToFiles(result.diff);
        setFile(files.find((f) => f.path === filePath || f.oldPath === filePath) ?? null);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Failed to load diff');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId, filePath, diffRef, reloadTick]);

  // The working tree moves under us; committed refs do not.
  useEffect(() => {
    if (!isWorkingTreeRef(diffRef)) return;
    const handlePanelEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      if (REFRESH_EVENTS.has(event.detail?.type)) setReloadTick((tick) => tick + 1);
    };
    window.addEventListener('panel:event', handlePanelEvent);
    return () => window.removeEventListener('panel:event', handlePanelEvent);
  }, [diffRef]);

  const handleViewTypeChange = useCallback((mode: DiffModeEnum) => {
    setViewType(mode);
    localStorage.setItem('diffViewType', mode === DiffModeEnum.Split ? 'split' : 'inline');
  }, []);

  const diffData = useMemo(() => {
    if (!file || file.isBinary || !file.rawDiff.includes('@@')) return null;
    return {
      oldFile: { fileName: file.oldPath || file.path },
      newFile: { fileName: file.path },
      hunks: [file.rawDiff],
    };
  }, [file]);

  const canOpenFile = file ? file.type !== 'deleted' : true;

  return (
    <div className="h-full w-full min-w-0 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-surface-secondary border-b border-border-primary">
        <div className="flex min-w-0 items-center gap-2">
          <FileDiffIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
          <span className="min-w-0 truncate text-sm text-text-primary">{filePath}</span>
          <span className="flex-shrink-0 text-xs text-text-tertiary">{diffRefLabel(diffRef)}</span>
          {file && (
            <span className="flex flex-shrink-0 items-center gap-1 text-xs tabular-nums">
              {file.additions > 0 && <span className="font-semibold text-status-success">+{file.additions}</span>}
              {file.deletions > 0 && <span className="font-semibold text-status-error">-{file.deletions}</span>}
            </span>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {canOpenFile && (
            <button
              type="button"
              onClick={() => { void openFileInEditor({ sessionId, filePath, pin: true }); }}
              className="flex items-center gap-1 rounded-md border border-border-primary bg-surface-tertiary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              aria-label={`Open ${filePath} in Editor`}
            >
              <ExternalLink className="w-3 h-3" />
              Open file
            </button>
          )}
          <div className="inline-flex rounded-md border border-border-primary bg-surface-primary">
            <button
              type="button"
              onClick={() => handleViewTypeChange(DiffModeEnum.Unified)}
              aria-pressed={viewType === DiffModeEnum.Unified}
              className={`px-2.5 py-1 text-xs font-medium rounded-l-md ${
                viewType === DiffModeEnum.Unified ? 'bg-interactive text-text-on-interactive' : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              Unified
            </button>
            <button
              type="button"
              onClick={() => handleViewTypeChange(DiffModeEnum.Split)}
              aria-pressed={viewType === DiffModeEnum.Split}
              className={`px-2.5 py-1 text-xs font-medium rounded-r-md ${
                viewType === DiffModeEnum.Split ? 'bg-interactive text-text-on-interactive' : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              Split
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {loading && !file ? (
          <div className="flex items-center gap-2 p-4 text-sm text-text-secondary">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading diff…
          </div>
        ) : error ? (
          <div role="alert" className="m-4 rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">{error}</div>
        ) : !file ? (
          <div className="p-4 text-sm text-text-tertiary">This file has no changes in {diffRefLabel(diffRef)}.</div>
        ) : file.isBinary ? (
          <div className="p-4 text-sm text-text-secondary">Binary file</div>
        ) : diffData ? (
          <DiffView
            data={diffData}
            diffViewMode={viewType}
            diffViewTheme={isDarkMode ? 'dark' : 'light'}
            diffViewHighlight={!!highlighter}
            registerHighlighter={highlighter ?? undefined}
            diffViewWrap={true}
            diffViewFontSize={13}
          />
        ) : (
          <div className="p-4 text-sm text-text-tertiary">
            {file.type === 'renamed' ? 'File renamed (no content changes)' : 'No content changes'}
          </div>
        )}
      </div>
    </div>
  );
}
