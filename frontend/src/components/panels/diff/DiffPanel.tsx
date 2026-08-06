import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import CombinedDiffView from './CombinedDiffView';
import type { CombinedDiffViewHandle } from './CombinedDiffView';
import type { ToolPanel, DiffPanelState } from '../../../../../shared/types/panels';
import type { GitStatus } from '../../../types/session';
import { AlertCircle, GitBranch, Globe } from 'lucide-react';
import { useSession } from '../../../contexts/SessionContext';
import { cn } from '../../../utils/cn';
import { Tooltip } from '../../ui/Tooltip';
import BrowserSurface from '../browser/BrowserSurface';
import {
  consumeLocalReviewModeRequest,
  getEffectiveReviewMode,
  getReviewDefaultMode,
  setReviewDefaultMode,
  subscribeReviewDefaultMode,
  subscribeLocalReviewModeRequest,
  type ReviewMode,
} from './reviewModePreference';

interface DiffPanelProps {
  panel: ToolPanel;
  isActive: boolean;
  sessionId: string;
  isMainRepo?: boolean;
}

function buildGitStatusFingerprint(gitStatus?: GitStatus): string {
  return [
    gitStatus?.state ?? 'unknown',
    gitStatus?.ahead ?? 0,
    gitStatus?.behind ?? 0,
    gitStatus?.hasUncommittedChanges ? 1 : 0,
    gitStatus?.hasUntrackedFiles ? 1 : 0,
    gitStatus?.filesChanged ?? 0,
    gitStatus?.additions ?? 0,
    gitStatus?.deletions ?? 0,
    gitStatus?.commitAdditions ?? 0,
    gitStatus?.commitDeletions ?? 0,
    gitStatus?.commitFilesChanged ?? 0,
    gitStatus?.totalCommits ?? 0,
  ].join(':');
}

function buildGithubReviewUrl(prUrl?: string): string | null {
  if (!prUrl) return null;

  try {
    const url = new URL(prUrl);
    const normalizedPath = url.pathname.replace(/\/$/, '');
    if (!normalizedPath.endsWith('/files')) {
      url.pathname = `${normalizedPath}/files`;
    } else {
      url.pathname = normalizedPath;
    }
    return url.toString();
  } catch {
    return prUrl.endsWith('/files') ? prUrl : `${prUrl.replace(/\/$/, '')}/files`;
  }
}

export const DiffPanel: React.FC<DiffPanelProps> = ({
  panel,
  isActive,
  sessionId,
  isMainRepo = false
}) => {
  const sessionContext = useSession();
  const session = sessionContext?.session;
  const [isStale, setIsStale] = useState(false);
  const [reviewMode, setReviewModeState] = useState<ReviewMode>(() => (
    consumeLocalReviewModeRequest(sessionId) ? 'local' : getReviewDefaultMode()
  ));
  const diffState = panel.state?.customState as DiffPanelState | undefined;
  const lastRefreshRef = useRef<number>(Date.now());
  const combinedDiffRef = useRef<CombinedDiffViewHandle>(null);
  // Track diff-relevant git state to avoid spurious refreshes on no-op status events
  const lastGitFingerprintRef = useRef<string | null>(null);
  const wasActiveRef = useRef(isActive);
  const reviewUrl = useMemo(() => buildGithubReviewUrl(session?.gitStatus?.prUrl), [session?.gitStatus?.prUrl]);
  const effectiveReviewMode = getEffectiveReviewMode(reviewMode, !!reviewUrl);

  useEffect(() => subscribeReviewDefaultMode(setReviewModeState), []);

  useEffect(() => {
    if (consumeLocalReviewModeRequest(sessionId)) {
      setReviewModeState('local');
    }

    return subscribeLocalReviewModeRequest((eventSessionId) => {
      if (eventSessionId === sessionId) {
        setReviewModeState('local');
      }
    });
  }, [sessionId]);

  const handleReviewModeChange = useCallback((mode: ReviewMode) => {
    setReviewModeState(mode);
    setReviewDefaultMode(mode);
  }, []);

  // Listen for file change events from other panels
  useEffect(() => {
    const handlePanelEvent = (event: CustomEvent) => {
      const { type, source, data } = event.detail || {};

      // Mark as stale when files change from other panels
      if (type === 'files:changed' || type === 'terminal:command_executed') {
        if (source.sessionId === sessionId && source.panelId !== panel.id) {
          setIsStale(true);
        }
      } else if (type === 'git:operation_completed') {
        // Refresh diff when git operations complete for this session (e.g., merge to main)
        if (source?.sessionId === sessionId) {
          const op = data?.operation as string | undefined;
          if (!op || op === 'merge_to_main' || op === 'squash_and_merge') {
            setIsStale(true);
          }
        }
      }
    };

    window.addEventListener('panel:event', handlePanelEvent as EventListener);

    return () => {
      window.removeEventListener('panel:event', handlePanelEvent as EventListener);
    };
  }, [panel.id, sessionId]);

  // Listen for git-status-updated events (detects new commits from Claude, etc.)
  // Only mark stale when diff-relevant state actually changes, not on no-op refreshes
  useEffect(() => {
    lastGitFingerprintRef.current = null;

    const handleGitStatusUpdated = (event: Event) => {
      const { sessionId: eventSessionId, gitStatus } = (event as CustomEvent<{ sessionId: string; gitStatus?: GitStatus }>).detail || {};
      if (eventSessionId !== sessionId) return;

      // Fingerprint the diff-relevant fields — ignore no-op status refreshes
      const fingerprint = buildGitStatusFingerprint(gitStatus);
      if (lastGitFingerprintRef.current === null) {
        lastGitFingerprintRef.current = fingerprint;
        return;
      }
      if (fingerprint === lastGitFingerprintRef.current) return;
      lastGitFingerprintRef.current = fingerprint;

      setIsStale(true);
    };

    window.addEventListener('git-status-updated', handleGitStatusUpdated);
    return () => window.removeEventListener('git-status-updated', handleGitStatusUpdated);
  }, [sessionId]);

  // Auto-refresh when becoming active and stale
  useEffect(() => {
    const becameActive = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;

    if (becameActive && isStale && effectiveReviewMode === 'local') {
      setIsStale(false);
      combinedDiffRef.current?.refresh();

      const timer = setTimeout(() => {
        lastRefreshRef.current = Date.now();

        window.electron?.invoke('panels:update', panel.id, {
          state: {
            ...panel.state,
            customState: {
              ...diffState,
              lastRefresh: new Date().toISOString(),
              isDiffStale: false
            }
          }
        });

        window.dispatchEvent(new CustomEvent('panel:event', {
          detail: {
            type: 'diff:refreshed',
            source: {
              panelId: panel.id,
              panelType: 'diff',
              sessionId
            },
            timestamp: new Date().toISOString()
          }
        }));
      }, 500);

      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- panel.state/diffState intentionally excluded: they are written inside this effect via IPC and must not re-trigger it
  }, [effectiveReviewMode, isActive, isStale, panel.id, sessionId]);

  const prLabel = session?.gitStatus?.prNumber ? `#${session.gitStatus.prNumber}` : 'Pull Request';
  const githubModeButton = (
    <button
      type="button"
      onClick={() => reviewUrl && handleReviewModeChange('github')}
      disabled={!reviewUrl}
      aria-disabled={!reviewUrl}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors",
        !reviewUrl
          ? "text-text-muted cursor-not-allowed opacity-50"
          : effectiveReviewMode === 'github'
          ? "bg-interactive text-text-on-interactive"
          : "text-text-secondary hover:bg-surface-hover"
      )}
      aria-pressed={effectiveReviewMode === 'github'}
      title={!reviewUrl ? 'Open a PR to enable' : undefined}
    >
      <Globe className="w-3 h-3" />
      GitHub
    </button>
  );

  return (
    <div className="diff-panel h-full flex flex-col bg-bg-primary">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-border-primary bg-surface-secondary flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
          <span className="text-xs font-medium text-text-secondary truncate">Review</span>
          {reviewUrl ? (
            <>
              <span className="text-xs text-text-muted truncate">{prLabel}</span>
              {session?.gitStatus?.prTitle && (
                <span className="text-xs text-text-tertiary truncate">{session.gitStatus.prTitle}</span>
              )}
            </>
          ) : (
            <span className="text-xs text-text-muted truncate">Local changes</span>
          )}
        </div>

        <div className="inline-flex items-center rounded border border-border-primary bg-bg-primary p-0.5 flex-shrink-0">
          {reviewUrl ? githubModeButton : (
            <Tooltip content="Open a PR to enable" side="bottom">
              {githubModeButton}
            </Tooltip>
          )}
          <button
            type="button"
            onClick={() => handleReviewModeChange('local')}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors",
              effectiveReviewMode === 'local'
                ? "bg-interactive text-text-on-interactive"
                : "text-text-secondary hover:bg-surface-hover"
            )}
            aria-pressed={effectiveReviewMode === 'local'}
          >
            <GitBranch className="w-3 h-3" />
            Local
          </button>
        </div>
      </div>

      {/* Stale indicator bar */}
      {effectiveReviewMode === 'local' && isStale && !isActive && (
        <div className="bg-status-warning/10 border-b border-status-warning/30 px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-status-warning text-sm">
            <AlertCircle className="w-4 h-4" />
            <span>Files changed - switch to diff panel to refresh</span>
          </div>
        </div>
      )}

      {/* Main diff view */}
      <div className="flex-1 overflow-hidden">
        {effectiveReviewMode === 'github' && reviewUrl ? (
          <BrowserSurface
            panelId={panel.id}
            sessionId={sessionId}
            url={reviewUrl}
            isActive={isActive}
            compact
          />
        ) : (
          <CombinedDiffView
            ref={combinedDiffRef}
            sessionId={sessionId}
            selectedExecutions={[]}
            isGitOperationRunning={false}
            isMainRepo={isMainRepo}
            isVisible={isActive}
          />
        )}
      </div>
    </div>
  );
};

export default DiffPanel;
