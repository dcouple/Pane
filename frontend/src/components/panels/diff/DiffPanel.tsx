import React, { useEffect, useState, useRef } from 'react';
import CombinedDiffView from './CombinedDiffView';
import type { CombinedDiffViewHandle } from './CombinedDiffView';
import type { ToolPanel, DiffPanelState } from '../../../../../shared/types/panels';
import { AlertCircle } from 'lucide-react';

interface DiffPanelProps {
  panel: ToolPanel;
  isActive: boolean;
  sessionId: string;
  isMainRepo?: boolean;
}

export const DiffPanel: React.FC<DiffPanelProps> = ({
  panel,
  isActive,
  sessionId,
  isMainRepo = false
}) => {
  const [isStale, setIsStale] = useState(false);
  const diffState = panel.state?.customState as DiffPanelState | undefined;
  const lastRefreshRef = useRef<number>(Date.now());
  const combinedDiffRef = useRef<CombinedDiffViewHandle>(null);
  // Track diff-relevant git state to avoid spurious refreshes on no-op status events
  const lastGitFingerprintRef = useRef<string>('');

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
    const handleGitStatusUpdated = (event: Event) => {
      const { sessionId: eventSessionId, gitStatus } = (event as CustomEvent).detail || {};
      if (eventSessionId !== sessionId) return;

      // Fingerprint the diff-relevant fields — ignore no-op status refreshes
      const fingerprint = `${gitStatus?.state}-${gitStatus?.ahead}-${gitStatus?.behind}-${gitStatus?.uncommittedChanges}`;
      if (fingerprint === lastGitFingerprintRef.current) return;
      lastGitFingerprintRef.current = fingerprint;

      setIsStale(true);
    };

    window.addEventListener('git-status-updated', handleGitStatusUpdated);
    return () => window.removeEventListener('git-status-updated', handleGitStatusUpdated);
  }, [sessionId]);

  // Auto-refresh when becoming active and stale
  useEffect(() => {
    if (isActive && isStale) {
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
  }, [isActive, isStale, panel.id, sessionId]);

  return (
    <div className="diff-panel h-full flex flex-col bg-bg-primary">
      {/* Stale indicator bar */}
      {isStale && !isActive && (
        <div className="bg-status-warning/10 border-b border-status-warning/30 px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-status-warning text-sm">
            <AlertCircle className="w-4 h-4" />
            <span>Files changed - switch to diff panel to refresh</span>
          </div>
        </div>
      )}

      {/* Main diff view */}
      <div className="flex-1 overflow-hidden">
        <CombinedDiffView
          ref={combinedDiffRef}
          sessionId={sessionId}
          selectedExecutions={[]}
          isGitOperationRunning={false}
          isMainRepo={isMainRepo}
          isVisible={isActive}
        />
      </div>
    </div>
  );
};

export default DiffPanel;
