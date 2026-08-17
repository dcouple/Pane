import React, { useMemo } from 'react';
import { AlertTriangle, ArrowLeftRight, ChevronDown, ChevronUp, Code2, GitBranch, Settings, TerminalSquare } from 'lucide-react';
import { useSession } from '../contexts/SessionContext';
import { useNavigationStore } from '../stores/navigationStore';
import { Button } from './ui/Button';
import { Dropdown, DropdownMenuItem } from './ui/Dropdown';
import { Tooltip } from './ui/Tooltip';
import { GitHistoryGraph } from './GitHistoryGraph';

interface HorizontalDetailPanelProps {
  height?: number;
  onResize: (event: React.MouseEvent) => void;
  mergeError?: string | null;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onSwapLayout?: () => void;
  terminalShortcuts?: React.ReactNode;
  onCommitClick?: (hash: string) => void;
}

export function HorizontalDetailPanel({
  height,
  onResize,
  mergeError,
  isCollapsed,
  onToggleCollapse,
  onSwapLayout,
  terminalShortcuts,
  onCommitClick,
}: HorizontalDetailPanelProps) {
  const sessionContext = useSession();
  const immersiveMode = useNavigationStore(state => state.immersiveMode);
  const remoteIdeTooltip = 'Open in IDE is only available in local mode. Switch this client back to the local runtime to use your desktop IDE.';
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

  const {
    session,
    gitBranchActions,
    isMerging,
    gitCommands,
    onOpenIDEWithCommand,
    onConfigureIDE,
    isRemoteMode,
  } = sessionContext;
  const gitStatus = session.gitStatus;
  const isProject = !!session.isMainRepo;
  const gitUnavailable = isProject && gitStatus?.state === 'unknown';

  return (
    <div
      className={`pane-detail-panel pane-detail-panel-horizontal flex-shrink-0 bg-surface-primary flex flex-col overflow-hidden relative transition-[height] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${immersiveMode ? '' : 'border-t border-border-primary'}`}
      style={{ height: immersiveMode ? '0px' : isCollapsed ? 'auto' : `${height ?? 200}px` }}
    >
      {!isCollapsed && (
        <div
          role="separator"
          aria-label="Resize detail panel"
          aria-orientation="horizontal"
          tabIndex={-1}
          className="absolute top-0 left-0 right-0 h-1 cursor-row-resize group z-10"
          onMouseDown={onResize}
        >
          <div className="absolute -top-2 bottom-0 left-0 right-0" />
        </div>
      )}

      <div className="pane-detail-panel-inner flex flex-col h-full min-h-0">
        <div className="flex items-start flex-shrink-0">
          <div className="flex items-center flex-wrap flex-1 min-w-0 min-h-[32px] px-3 gap-x-2 gap-y-1 py-1">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="p-0.5 hover:bg-surface-hover rounded transition-colors"
              title={isCollapsed ? 'Expand detail panel' : 'Collapse detail panel'}
            >
              {isCollapsed
                ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" />
                : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
            </button>

            <GitBranch className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
            <span className="text-sm text-text-primary font-medium truncate max-w-[150px]">
              {gitCommands?.currentBranch?.trim() || session.baseBranch?.replace(/^origin\//, '') || 'unknown'}
            </span>

            {!isProject && gitStatus && (
              <div className="flex items-center gap-2 flex-shrink-0">
                {!!gitStatus.ahead && <span className="text-[10px] text-status-success font-medium">&uarr;{gitStatus.ahead}</span>}
                {!!gitStatus.behind && <span className="text-[10px] text-status-warning font-medium">&darr;{gitStatus.behind}</span>}
                {gitStatus.hasUncommittedChanges && !!gitStatus.filesChanged && (
                  <span className="text-[10px] text-status-info font-medium">{gitStatus.filesChanged} files</span>
                )}
              </div>
            )}

            {mergeError && (
              <Tooltip content={mergeError} side="top">
                <AlertTriangle className="w-3.5 h-3.5 text-status-error flex-shrink-0" />
              </Tooltip>
            )}

            {!gitUnavailable && !isProject && gitBranchActions?.map(action => (
              <Tooltip key={action.id} content={action.label + (action.description ? ` — ${action.description}` : '')} side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  className="!px-1.5 !py-0.5 text-xs h-6 flex-shrink-0"
                  onClick={action.onClick}
                  disabled={action.disabled || isMerging}
                >
                  <action.icon className="w-3 h-3" />
                </Button>
              </Tooltip>
            ))}

            {onOpenIDEWithCommand && (isRemoteMode ? (
              <Tooltip content={remoteIdeTooltip} side="top">
                <span>
                  <Button variant="ghost" size="sm" className="!px-1.5 !py-0.5 text-xs h-6 flex-shrink-0" disabled>
                    <Code2 className="w-3 h-3" />
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Dropdown
                trigger={(
                  <Tooltip content="Open in IDE" side="top">
                    <Button variant="ghost" size="sm" className="!px-1.5 !py-0.5 text-xs h-6 flex-shrink-0">
                      <Code2 className="w-3 h-3" />
                    </Button>
                  </Tooltip>
                )}
                items={ideItems}
                footer={onConfigureIDE ? <DropdownMenuItem icon={Settings} label="Configure..." onClick={onConfigureIDE} /> : undefined}
                position="auto"
                width="sm"
              />
            ))}

            {terminalShortcuts}
          </div>

          {onSwapLayout && (
            <Tooltip content="Swap terminal and detail panel positions" side="top">
              <button
                type="button"
                aria-label="Swap terminal and detail panel positions"
                onClick={onSwapLayout}
                className="p-1 hover:bg-surface-hover rounded transition-colors flex-shrink-0 mr-2 mt-1"
              >
                <ArrowLeftRight aria-hidden="true" className="w-3.5 h-3.5 text-text-tertiary" />
              </button>
            </Tooltip>
          )}
        </div>

        {!isCollapsed && !gitUnavailable && session.worktreePath && (
          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
            <GitHistoryGraph
              sessionId={session.id}
              baseBranch={session.baseBranch || 'main'}
              layout="wide"
              onCommitClick={onCommitClick}
            />
          </div>
        )}
      </div>
    </div>
  );
}
