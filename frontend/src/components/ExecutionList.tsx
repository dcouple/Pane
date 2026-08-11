import React, { useState, memo, useCallback } from 'react';
import { RotateCcw, GitCommitHorizontal, ChevronRight, ChevronDown } from 'lucide-react';
import type { ExecutionListProps, ExecutionDiff } from '../types/diff';
import { useScrollSurface } from '../hooks/useScrollSurface';
import { CommitFileList } from './git/CommitFileList';

/** Pseudo-ref the backend understands for uncommitted working-tree changes. */
const WORKING_TREE_REF = 'index';

function executionRef(execution: ExecutionDiff): string | null {
  if (execution.id === 0) return WORKING_TREE_REF;
  const hash = execution.after_commit_hash;
  if (!hash || hash === 'UNCOMMITTED') return null;
  return hash;
}

const ExecutionList: React.FC<ExecutionListProps> = memo(({
  sessionId,
  executions,
  selectedExecutions,
  onSelectionChange,
  onCommit,
  onRevert,
  onRestore,
  historyLimitReached = false,
  historyLimit,
  onFileClick
}) => {
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limitDisplay = historyLimit ?? 50;
  const executionListRef = React.useRef<HTMLDivElement>(null);
  const scrollSurfaceRef = useScrollSurface<HTMLDivElement>({
    id: `review-history:${sessionId}`,
    sessionId,
    priority: 80,
    ownerElement: () => executionListRef.current,
  });

  const toggleExpanded = useCallback((executionId: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(executionId)) next.delete(executionId);
      else next.add(executionId);
      return next;
    });
  }, []);

  const handleCommitClick = (executionId: number, event: React.MouseEvent) => {
    if (event.shiftKey && rangeStart !== null) {
      const start = Math.min(rangeStart, executionId);
      const end = Math.max(rangeStart, executionId);
      onSelectionChange([start, end]);
    } else {
      setRangeStart(executionId);
      onSelectionChange([executionId]);
    }
  };

  const handleSelectAll = () => {
    if (executions.length > 0) {
      const firstId = executions[executions.length - 1].id;
      const lastId = executions.find(e => e.id !== 0)?.id || firstId;
      onSelectionChange([firstId, lastId]);
    }
  };

  const truncateMessage = (message: string, maxLength: number = 50) => {
    if (message.length <= maxLength) return message;
    return message.substring(0, maxLength) + '...';
  };

  const isInRange = (executionId: number): boolean => {
    if (selectedExecutions.length === 0) return false;
    if (selectedExecutions.length === 1) return selectedExecutions[0] === executionId;
    if (selectedExecutions.length === 2) {
      const [start, end] = selectedExecutions;
      return executionId >= Math.min(start, end) && executionId <= Math.max(start, end);
    }
    return false;
  };

  if (executions.length === 0) {
    return (
      <div className="p-4 text-text-tertiary text-center text-xs">
        No commits found
      </div>
    );
  }

  return (
    <div ref={executionListRef} className="execution-list h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-border-primary flex items-center justify-between">
        <span className="text-[11px] font-medium text-text-tertiary uppercase tracking-wider">
          Commits <span className="text-text-muted">{executions.filter(e => e.id !== 0).length}</span>
        </span>
        <button
          type="button"
          onClick={handleSelectAll}
          className="text-[10px] text-text-muted hover:text-interactive transition-colors"
        >
          Select all
        </button>
      </div>

      {/* Commit list */}
      <div ref={scrollSurfaceRef} tabIndex={-1} className="flex-1 overflow-y-auto min-h-0">
        {executions.map((execution, idx) => {
          const isSelected = isInRange(execution.id);
          const isUncommitted = execution.id === 0;
          const isFirst = idx === 0;
          const isLast = idx === executions.length - 1;
          const commitRef = executionRef(execution);
          const isExpanded = expandedIds.has(execution.id);
          const canExpand = commitRef !== null && execution.stats_files_changed > 0;
          const filesPanelId = `execution-files-${execution.id}`;

          return (
            <div key={execution.id}>
            <div
              className={`
                group relative flex items-stretch gap-2 px-3 transition-colors
                ${isSelected ? 'bg-interactive/10 border-l-2 border-l-interactive' : 'border-l-2 border-l-transparent hover:bg-surface-hover'}
                ${isUncommitted ? 'bg-status-warning/5' : ''}
              `}
            >
              <button
                type="button"
                aria-pressed={isSelected}
                aria-label={`Select ${isUncommitted ? 'uncommitted changes' : execution.commit_message || execution.prompt_text || `commit ${execution.execution_sequence}`}`}
                onClick={(event) => handleCommitClick(execution.id, event)}
                className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
              />
              {/* Graph rail: vertical line with commit node */}
              <div className="relative z-10 pointer-events-none flex flex-col items-center flex-shrink-0 w-3.5">
                <div className={`w-px flex-1 ${isFirst ? 'bg-transparent' : 'bg-border-secondary'}`} />
                <GitCommitHorizontal
                  className={`w-3.5 h-3.5 flex-shrink-0 rotate-90 ${
                    isUncommitted ? 'text-status-warning' : isSelected ? 'text-interactive' : 'text-text-muted'
                  }`}
                />
                <div className={`w-px flex-1 ${isLast ? 'bg-transparent' : 'bg-border-secondary'}`} />
              </div>

              {/* Content */}
              <div className="relative z-10 pointer-events-none flex-1 min-w-0 py-1.5">
                {/* Message + hash */}
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span
                    className={`text-xs leading-snug truncate ${isUncommitted ? 'text-status-warning font-medium italic' : 'text-text-primary'}`}
                    title={isUncommitted ? 'Uncommitted changes' : (execution.commit_message || execution.prompt_text || `Commit ${execution.execution_sequence}`)}
                  >
                    {isUncommitted
                      ? 'Uncommitted changes'
                      : truncateMessage(execution.commit_message || execution.prompt_text || `Commit ${execution.execution_sequence}`)}
                  </span>
                  {execution.after_commit_hash && execution.after_commit_hash !== 'UNCOMMITTED' && (
                    <span className="text-[10px] text-text-muted font-mono flex-shrink-0">
                      {execution.after_commit_hash.substring(0, 7)}
                    </span>
                  )}
                </div>

                {/* Stats + actions */}
                <div className="flex items-start justify-between mt-0.5">
                  {canExpand ? (
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={filesPanelId}
                      aria-label={`${isExpanded ? 'Hide' : 'Show'} changed files`}
                      onClick={(e) => { e.stopPropagation(); toggleExpanded(execution.id); }}
                      className="pointer-events-auto -ml-0.5 flex items-center gap-1 rounded px-0.5 text-[10px] text-text-muted transition-colors hover:text-text-secondary focus:outline-none focus:ring-1 focus:ring-interactive"
                    >
                      {isExpanded
                        ? <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                        : <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />}
                      <span className="text-status-success">+{execution.stats_additions}</span>
                      <span className="text-status-error">-{execution.stats_deletions}</span>
                      <span>{execution.stats_files_changed} {execution.stats_files_changed === 1 ? 'file' : 'files'}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
                      {execution.stats_files_changed > 0 ? (
                        <>
                          <span className="text-status-success">+{execution.stats_additions}</span>
                          <span className="text-status-error">-{execution.stats_deletions}</span>
                          <span>{execution.stats_files_changed} {execution.stats_files_changed === 1 ? 'file' : 'files'}</span>
                        </>
                      ) : (
                        <span>No changes</span>
                      )}
                    </div>
                  )}
                  <div className="pointer-events-auto flex flex-col items-end gap-0.5 flex-shrink-0">
                    {isUncommitted && onCommit && execution.stats_files_changed > 0 && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onCommit(); }}
                        className="text-[10px] px-1.5 py-0.5 rounded text-status-success hover:bg-status-success/15 transition-colors font-medium"
                      >
                        Commit
                      </button>
                    )}
                    {isUncommitted && onRestore && execution.stats_files_changed > 0 && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onRestore(); }}
                        className="text-[10px] px-1.5 py-0.5 rounded text-status-warning hover:bg-status-warning/15 transition-colors font-medium"
                        title="Restore all uncommitted changes"
                      >
                        Restore
                      </button>
                    )}
                    {onRevert && !isUncommitted && execution.after_commit_hash && execution.after_commit_hash !== 'UNCOMMITTED' && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onRevert(execution.after_commit_hash!); }}
                        className="text-[10px] p-0.5 rounded text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                        aria-label="Revert this commit"
                      >
                        <RotateCcw className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {isExpanded && commitRef && (
              <div
                id={filesPanelId}
                className={`border-l-2 ${isSelected ? 'border-l-interactive bg-interactive/5' : 'border-l-transparent'} pl-3`}
              >
                <CommitFileList
                  sessionId={sessionId}
                  commitRef={commitRef}
                  onFileClick={onFileClick}
                />
              </div>
            )}
            </div>
          );
        })}
        {historyLimitReached && (
          <div className="px-3 py-1.5 text-[10px] text-text-muted">
            Showing last {limitDisplay} commits
          </div>
        )}
      </div>
    </div>
  );
});

ExecutionList.displayName = 'ExecutionList';

export default ExecutionList;
