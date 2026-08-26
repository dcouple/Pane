import React, { useMemo } from 'react';
import { AlertTriangle, ArrowLeftRight, Code2, GitBranch, Link, Settings, TerminalSquare } from 'lucide-react';
import { useSession } from '../contexts/SessionContext';
import { useNavigationStore } from '../stores/navigationStore';
import { DetailPanelGitActions } from './DetailPanelGitActions';
import { GitHistoryGraph } from './GitHistoryGraph';
import { HorizontalDetailPanel } from './HorizontalDetailPanel';
import { Button } from './ui/Button';
import { Dropdown, DropdownMenuItem } from './ui/Dropdown';
import { Tooltip } from './ui/Tooltip';
import { useScrollSurface } from '../hooks/useScrollSurface';

interface DetailPanelProps {
  isVisible: boolean;
  onToggle: () => void;
  width: number;
  height?: number;
  onResize: (event: React.MouseEvent) => void;
  mergeError?: string | null;
  orientation?: 'vertical' | 'horizontal';
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onSwapLayout?: () => void;
  terminalShortcuts?: React.ReactNode;
  onCommitClick?: (hash: string) => void;
  onCommitFileClick?: (hash: string, path: string) => void;
}

const sidebarButtonClass = 'w-full justify-start text-sm !px-2';
const remoteIdeTooltip = 'Open in IDE is only available in local mode. Switch this client back to the local runtime to use your desktop IDE.';

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs uppercase text-text-tertiary font-medium mb-2 px-1">{children}</h3>;
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-2 py-2 border-b border-border-primary">
      <SectionHeader>{title}</SectionHeader>
      {children}
    </div>
  );
}

export function DetailPanel({
  isVisible,
  width,
  height,
  onResize,
  mergeError,
  orientation,
  isCollapsed,
  onToggleCollapse,
  onSwapLayout,
  terminalShortcuts,
  onCommitClick,
  onCommitFileClick,
}: DetailPanelProps) {
  const sessionContext = useSession();
  const immersiveMode = useNavigationStore(state => state.immersiveMode);
  const detailPanelRef = React.useRef<HTMLDivElement>(null);
  const detailScrollSurfaceRef = useScrollSurface<HTMLDivElement>({
    id: `detail:${sessionContext?.session.id ?? 'unavailable'}`,
    sessionId: sessionContext?.session.id,
    enabled: Boolean(sessionContext && isVisible && !immersiveMode && orientation !== 'horizontal'),
    priority: 30,
    ownerElement: () => detailPanelRef.current,
  });
  const ideItems = useMemo(() => {
    if (!sessionContext?.onOpenIDEWithCommand) return [];
    const handler = sessionContext.onOpenIDEWithCommand;
    const configured = sessionContext.configuredIDECommand?.trim();
    const isCustom = configured && !['code .', 'cursor .'].includes(configured);
    return [
      ...(isCustom
        ? [{ id: 'configured', label: configured, description: 'Project default', icon: TerminalSquare, onClick: () => handler() }]
        : []),
      { id: 'vscode', label: 'VS Code', description: 'code .', icon: Code2, onClick: () => handler('vscode') },
      { id: 'cursor', label: 'Cursor', description: 'cursor .', icon: Code2, onClick: () => handler('cursor') },
    ];
  }, [sessionContext?.configuredIDECommand, sessionContext?.onOpenIDEWithCommand]);

  if (!sessionContext) return null;
  if (orientation === 'horizontal') {
    return (
      <HorizontalDetailPanel
        height={height}
        onResize={onResize}
        mergeError={mergeError}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        onSwapLayout={onSwapLayout}
        terminalShortcuts={terminalShortcuts}
        onCommitClick={onCommitClick}
        onCommitFileClick={onCommitFileClick}
      />
    );
  }

  const {
    session,
    gitBranchActions,
    isMerging,
    gitCommands,
    onOpenIDEWithCommand,
    onConfigureIDE,
    onSetTracking,
    trackingBranch,
    isRemoteMode,
  } = sessionContext;
  const gitStatus = session.gitStatus;
  const gitUnavailable = !!session.isMainRepo && gitStatus?.state === 'unknown';

  return (
    <div
      ref={detailPanelRef}
      className={`pane-detail-panel pane-detail-panel-vertical flex-shrink-0 min-w-0 bg-surface-primary flex flex-col overflow-hidden relative transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${isVisible && !immersiveMode ? 'border-l border-border-primary' : ''}`}
      style={{ width: isVisible && !immersiveMode ? `${width}px` : '0px' }}
    >
      <div className="absolute top-0 left-0 w-1 h-full cursor-col-resize group z-10" onMouseDown={onResize}>
        <div className="absolute -left-2 right-0 top-0 bottom-0" />
      </div>

      <div className="pane-detail-panel-inner flex flex-col h-full min-h-0">
        <div className="flex-shrink-0 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border-primary min-w-0">
            <GitBranch className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
            <span className="flex flex-col leading-tight min-w-0 flex-1">
              <span className="text-sm text-text-primary font-medium truncate">
                {gitCommands?.currentBranch?.trim() || session.baseBranch?.replace(/^origin\//, '') || 'unknown'}
              </span>
              {session.baseBranch && gitCommands?.currentBranch
                && gitCommands.currentBranch !== session.baseBranch.replace(/^origin\//, '') && (
                <span className="text-xs text-text-tertiary truncate">
                  from {session.baseBranch.replace(/^origin\//, '')}
                </span>
              )}
            </span>
            {onSwapLayout && (
              <Tooltip content="Swap terminal and detail panel positions" side="left">
                <button
                  type="button"
                  aria-label="Swap terminal and detail panel positions"
                  onClick={onSwapLayout}
                  className="p-1 hover:bg-surface-hover rounded transition-colors flex-shrink-0"
                >
                  <ArrowLeftRight aria-hidden="true" className="w-3.5 h-3.5 text-text-tertiary" />
                </button>
              </Tooltip>
            )}
          </div>

          {gitStatus && (
            <DetailSection title="Changes">
              <div className="space-y-1 text-sm px-1">
                {!!gitStatus.ahead && (
                  <div className="flex justify-between text-text-secondary">
                    <span>Commits ahead</span>
                    <span className="text-status-success font-medium">{gitStatus.ahead}</span>
                  </div>
                )}
                {!!gitStatus.behind && (
                  <div className="flex justify-between text-text-secondary">
                    <span>Commits behind</span>
                    <span className="text-status-warning font-medium">{gitStatus.behind}</span>
                  </div>
                )}
                {gitStatus.hasUncommittedChanges && !!gitStatus.filesChanged && (
                  <div className="flex justify-between text-text-secondary">
                    <span>Uncommitted files</span>
                    <span className="text-status-info font-medium">{gitStatus.filesChanged}</span>
                  </div>
                )}
                {!gitStatus.ahead && !gitStatus.behind && !gitStatus.hasUncommittedChanges && (
                  <div className="text-text-tertiary text-xs">No changes detected</div>
                )}
              </div>
            </DetailSection>
          )}

          {(onSetTracking || onOpenIDEWithCommand) && (
            <DetailSection title="Branch">
              <div className="space-y-0.5">
                {!gitUnavailable && onSetTracking && (
                  <Tooltip content="Set upstream tracking branch for git pull/push" side="left">
                    <Button variant="ghost" size="sm" className={sidebarButtonClass} onClick={onSetTracking} disabled={isMerging}>
                      <Link className="w-4 h-4 mr-2 flex-shrink-0" />
                      <span className="flex flex-col items-start leading-tight min-w-0">
                        <span>Set Tracking</span>
                        {trackingBranch && <span className="text-xs text-text-tertiary truncate max-w-full">{trackingBranch}</span>}
                      </span>
                    </Button>
                  </Tooltip>
                )}
                {onOpenIDEWithCommand && (isRemoteMode ? (
                  <Tooltip content={remoteIdeTooltip} side="left">
                    <span>
                      <Button variant="ghost" size="sm" className={sidebarButtonClass} disabled>
                        <Code2 className="w-4 h-4 mr-2 flex-shrink-0" />
                        <span className="truncate">Open in IDE</span>
                      </Button>
                    </span>
                  </Tooltip>
                ) : (
                  <Dropdown
                    trigger={(
                      <Button variant="ghost" size="sm" className={sidebarButtonClass}>
                        <Code2 className="w-4 h-4 mr-2 flex-shrink-0" />
                        <span className="truncate">Open in IDE</span>
                      </Button>
                    )}
                    items={ideItems}
                    footer={onConfigureIDE ? <DropdownMenuItem icon={Settings} label="Configure..." onClick={onConfigureIDE} /> : undefined}
                    position="auto"
                    width="sm"
                  />
                ))}
              </div>
            </DetailSection>
          )}

          {mergeError && (
            <div className="px-2 py-2 border-b border-border-primary">
              <div className="p-2 bg-status-error/10 border border-status-error/30 rounded-md">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-status-error flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-status-error">{mergeError}</p>
                </div>
              </div>
            </div>
          )}

          {gitUnavailable ? (
            <div className="px-3 py-4 border-b border-border-primary">
              <p className="text-xs text-text-tertiary">
                Git features unavailable. Initialize a git repository to enable history, branches, and sync.
              </p>
            </div>
          ) : (
            <DetailPanelGitActions
              actions={gitBranchActions}
              isMerging={isMerging}
              gitCommands={gitCommands}
              gitStatus={gitStatus}
            />
          )}
        </div>

        {!gitUnavailable && session.worktreePath && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="px-2 pt-2 flex-shrink-0"><SectionHeader>History</SectionHeader></div>
            <div ref={detailScrollSurfaceRef} role="region" tabIndex={0} aria-label="Commit history" className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
              <GitHistoryGraph
                sessionId={session.id}
                baseBranch={session.baseBranch || 'main'}
                onCommitClick={onCommitClick}
                expandable
                onFileClick={onCommitFileClick}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
