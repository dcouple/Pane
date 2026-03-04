import React, { useMemo, useState, useCallback } from 'react';
import { useSession } from '../contexts/SessionContext';
import { GitBranch, AlertTriangle, Code2, Settings, Link, TerminalSquare, Copy, ClipboardPaste, Trash2, FileIcon } from 'lucide-react';
import { useSessionStore, type ClipboardFile } from '../stores/sessionStore';
import { usePanelStore } from '../stores/panelStore';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { Dropdown, DropdownMenuItem } from './ui/Dropdown';
import { GitHistoryGraph } from './GitHistoryGraph';

interface DetailPanelProps {
  isVisible: boolean;
  onToggle: () => void;
  width: number;
  onResize: (e: React.MouseEvent) => void;
  mergeError?: string | null;
  projectGitActions?: {
    onPull?: () => void;
    onPush?: () => void;
    isMerging?: boolean;
  };
}

/** Consistent compact button class for sidebar actions */
const sidebarBtn = 'w-full justify-start text-sm !px-2';

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs uppercase text-text-tertiary font-medium mb-2 px-1">{children}</h3>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-2 py-2 border-b border-border-primary">
      <SectionHeader>{title}</SectionHeader>
      {children}
    </div>
  );
}

export function DetailPanel({ isVisible, width, onResize, mergeError, projectGitActions }: DetailPanelProps) {
  const sessionContext = useSession();

  // Clipboard state
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const clipboardFiles = useSessionStore(state =>
    state.activeSessionId ? (state.clipboardFiles[state.activeSessionId] ?? []) : []
  );
  const [isClipboardDragging, setIsClipboardDragging] = useState(false);

  const copyPath = useCallback(async (absolutePath: string) => {
    await navigator.clipboard.writeText(absolutePath);
  }, []);

  const insertPath = useCallback(async (absolutePath: string) => {
    // Find the active terminal panel for this session via the panel store
    if (activeSessionId) {
      const { activePanels, panels } = usePanelStore.getState();
      const activePanelId = activePanels[activeSessionId];
      const activePanel = (panels[activeSessionId] || []).find(p => p.id === activePanelId);
      if (activePanel && activePanel.type === 'terminal') {
        await window.electronAPI.invoke('terminal:input', activePanel.id, absolutePath);
        return;
      }
    }

    // Fallback: copy to OS clipboard
    await navigator.clipboard.writeText(absolutePath);
  }, [activeSessionId]);

  const deleteFile = useCallback(async (id: string) => {
    if (!activeSessionId) return;
    await useSessionStore.getState().removeClipboardFile(id, activeSessionId);
  }, [activeSessionId]);

  const handleClipboardDragOver = useCallback((e: React.DragEvent) => {
    const hasFiles = Array.from(e.dataTransfer.items).some(item => item.kind === 'file');
    if (hasFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setIsClipboardDragging(true);
    }
  }, []);

  const handleClipboardDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsClipboardDragging(false);
    }
  }, []);

  const handleClipboardDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsClipboardDragging(false);
    if (!activeSessionId) return;

    const files = Array.from(e.dataTransfer.files).slice(0, 10);
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) continue;

      const reader = new FileReader();
      reader.onload = async (ev) => {
        if (!ev.target?.result || typeof ev.target.result !== 'string') return;
        const result = await window.electronAPI.clipboard.save(activeSessionId, {
          dataUrl: ev.target.result,
          mimeType: file.type,
          name: file.name,
          size: file.size,
        });
        if (result.success && result.data) {
          useSessionStore.getState().addClipboardFile(result.data);
        }
      };
      reader.onerror = () => console.error('[DetailPanel] Failed to read dropped file:', file.name);
      reader.readAsDataURL(file);
    }
  }, [activeSessionId]);

  // Build IDE dropdown items, sending safe IDE keys (resolved to commands server-side)
  const ideItems = useMemo(() => {
    if (!sessionContext?.onOpenIDEWithCommand) return [];
    const handler = sessionContext.onOpenIDEWithCommand;
    const configured = sessionContext.configuredIDECommand?.trim();
    const knownCommands = ['code .', 'cursor .'];
    const isCustom = configured && !knownCommands.includes(configured);
    const items = isCustom
      ? [{ id: 'configured', label: configured, description: 'Project default', icon: TerminalSquare, onClick: () => handler() }]
      : [];
    return [
      ...items,
      { id: 'vscode', label: 'VS Code', description: 'code .', icon: Code2, onClick: () => handler('vscode') },
      { id: 'cursor', label: 'Cursor', description: 'cursor .', icon: Code2, onClick: () => handler('cursor') },
    ];
  }, [sessionContext?.onOpenIDEWithCommand, sessionContext?.configuredIDECommand]);

  if (!isVisible || !sessionContext) return null;

  const { session, gitBranchActions, isMerging, gitCommands, onOpenIDEWithCommand, onConfigureIDE, onSetTracking, trackingBranch } = sessionContext;
  const gitStatus = session.gitStatus;
  const isProject = !!session.isMainRepo;

  return (
    <div
      className="flex-shrink-0 min-w-0 border-l border-border-primary bg-surface-primary flex flex-col overflow-hidden relative"
      style={{ width: `${width}px` }}
    >
      {/* Resize handle */}
      <div
        className="absolute top-0 left-0 w-1 h-full cursor-col-resize group z-10"
        onMouseDown={onResize}
      >
        <div className="absolute inset-0 group-hover:bg-interactive transition-colors" />
      </div>

      {/* Fixed top sections — never scroll */}
      <div className="flex-shrink-0 overflow-hidden">
        {/* Branch name — standalone header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-primary min-w-0">
          <GitBranch className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
          <span className="flex flex-col leading-tight min-w-0">
            <span className="text-sm text-text-primary font-medium truncate">
              {(gitCommands?.currentBranch?.trim()) || session.baseBranch?.replace(/^origin\//, '') || 'unknown'}
            </span>
            {session.baseBranch && gitCommands?.currentBranch &&
             gitCommands.currentBranch !== session.baseBranch.replace(/^origin\//, '') && (
              <span className="text-xs text-text-tertiary truncate">
                from {session.baseBranch.replace(/^origin\//, '')}
              </span>
            )}
          </span>
        </div>

        {/* Clipboard — worktree sessions only */}
        {!isProject && (
          <DetailSection title="Clipboard">
            {clipboardFiles.length === 0 ? (
              <div
                className={`text-text-tertiary text-xs px-1 py-2 border border-dashed rounded text-center ${
                  isClipboardDragging ? 'border-interactive bg-interactive/10' : 'border-border-primary'
                }`}
                onDragOver={handleClipboardDragOver}
                onDragLeave={handleClipboardDragLeave}
                onDrop={handleClipboardDrop}
              >
                Drop files here or Ctrl+V in terminal
              </div>
            ) : (
              <div
                className={`space-y-1.5 px-1 ${
                  isClipboardDragging ? 'ring-1 ring-interactive rounded' : ''
                }`}
                onDragOver={handleClipboardDragOver}
                onDragLeave={handleClipboardDragLeave}
                onDrop={handleClipboardDrop}
              >
                {clipboardFiles.slice(0, 3).map((file: ClipboardFile) => (
                  <div key={file.id} className="flex items-center gap-2 group">
                    <div className="w-8 h-8 flex items-center justify-center rounded border border-border-primary bg-surface-secondary flex-shrink-0">
                      <FileIcon className={`w-4 h-4 ${file.mimeType.startsWith('image/') ? 'text-interactive' : 'text-text-tertiary'}`} />
                    </div>
                    <span className="text-xs text-text-secondary truncate flex-1 min-w-0">{file.filename}</span>
                    <div className="flex gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => copyPath(file.absolutePath)} className="p-1 rounded hover:bg-surface-hover" title="Copy path">
                        <Copy className="w-3 h-3 text-text-tertiary" />
                      </button>
                      <button onClick={() => insertPath(file.absolutePath)} className="p-1 rounded hover:bg-surface-hover" title="Insert into terminal">
                        <ClipboardPaste className="w-3 h-3 text-text-tertiary" />
                      </button>
                      <button onClick={() => deleteFile(file.id)} className="p-1 rounded hover:bg-surface-hover" title="Delete">
                        <Trash2 className="w-3 h-3 text-text-tertiary" />
                      </button>
                    </div>
                  </div>
                ))}
                {clipboardFiles.length > 3 && (
                  <div className="text-text-tertiary text-xs text-center py-1">
                    +{clipboardFiles.length - 3} more
                  </div>
                )}
              </div>
            )}
          </DetailSection>
        )}

        {/* Changes — worktree sessions only */}
        {!isProject && gitStatus && (
          <DetailSection title="Changes">
            <div className="space-y-1 text-sm px-1">
              {gitStatus.ahead != null && gitStatus.ahead > 0 && (
                <div className="flex justify-between text-text-secondary">
                  <span>Commits ahead</span>
                  <span className="text-status-success font-medium">{gitStatus.ahead}</span>
                </div>
              )}
              {gitStatus.behind != null && gitStatus.behind > 0 && (
                <div className="flex justify-between text-text-secondary">
                  <span>Commits behind</span>
                  <span className="text-status-warning font-medium">{gitStatus.behind}</span>
                </div>
              )}
              {gitStatus.hasUncommittedChanges && gitStatus.filesChanged != null && gitStatus.filesChanged > 0 && (
                <div className="flex justify-between text-text-secondary">
                  <span>Uncommitted files</span>
                  <span className="text-status-info font-medium">{gitStatus.filesChanged}</span>
                </div>
              )}
              {(!gitStatus.ahead || gitStatus.ahead === 0) &&
               (!gitStatus.behind || gitStatus.behind === 0) &&
               !gitStatus.hasUncommittedChanges && (
                <div className="text-text-tertiary text-xs">No changes detected</div>
              )}
            </div>
          </DetailSection>
        )}

        {/* Branch actions */}
        {!isProject && (onSetTracking || onOpenIDEWithCommand) && (
          <DetailSection title="Branch">
            <div className="space-y-0.5">
              {onSetTracking && (
                <Tooltip content="Set upstream tracking branch for git pull/push" side="left">
                  <Button variant="ghost" size="sm" className={sidebarBtn} onClick={onSetTracking} disabled={isMerging}>
                    <Link className="w-4 h-4 mr-2 flex-shrink-0" />
                    <span className="flex flex-col items-start leading-tight min-w-0">
                      <span>Set Tracking</span>
                      {trackingBranch && (
                        <span className="text-xs text-text-tertiary truncate max-w-full">
                          {trackingBranch}
                        </span>
                      )}
                    </span>
                  </Button>
                </Tooltip>
              )}
              {onOpenIDEWithCommand && (
                <Dropdown
                  trigger={
                    <Button variant="ghost" size="sm" className={sidebarBtn}>
                      <Code2 className="w-4 h-4 mr-2 flex-shrink-0" />
                      <span className="truncate">Open in IDE</span>
                    </Button>
                  }
                  items={ideItems}
                  footer={
                    <DropdownMenuItem
                      icon={Settings}
                      label="Configure..."
                      onClick={onConfigureIDE}
                    />
                  }
                  position="auto"
                  width="sm"
                />
              )}
            </div>
          </DetailSection>
        )}

        {/* Merge error */}
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

        {/* Git actions */}
        <DetailSection title="Actions">
          <div className="space-y-0.5">
            {/* Worktree actions — ordered by workflow */}
            {!isProject && (() => {
              const byId = (id: string) => gitBranchActions?.find(a => a.id === id);
              const behindCount = gitStatus?.behind ?? 0;
              const aheadCount = gitStatus?.ahead ?? 0;
              const fetchedAgo = gitStatus?.lastChecked ? formatTimeAgo(gitStatus.lastChecked) : null;

              // Paired buttons rendered side-by-side
              const pairedIds = new Set(['pull', 'push', 'stash', 'stash-pop', 'rebase-from-main', 'rebase-to-main', 'fetch', 'commit']);

              // Layout: each entry is either a single action or a paired row
              type Row = { type: 'single'; action: NonNullable<typeof gitBranchActions>[number] }
                       | { type: 'pair'; left: NonNullable<typeof gitBranchActions>[number]; right: NonNullable<typeof gitBranchActions>[number] };
              const rows: Row[] = [];

              if (gitBranchActions) {
                for (let i = 0; i < gitBranchActions.length; i++) {
                  const action = gitBranchActions[i];
                  if (pairedIds.has(action.id)) {
                    // Fetch + Commit pair
                    if (action.id === 'fetch') {
                      const commit = byId('commit');
                      if (commit) { rows.push({ type: 'pair', left: action, right: commit }); continue; }
                    }
                    // Stash + Pop pair
                    if (action.id === 'stash') {
                      const pop = byId('stash-pop');
                      if (pop) { rows.push({ type: 'pair', left: action, right: pop }); continue; }
                    }
                    // Pull + Push pair
                    if (action.id === 'pull') {
                      const push = byId('push');
                      if (push) { rows.push({ type: 'pair', left: action, right: push }); continue; }
                    }
                    // Rebase + Merge pair
                    if (action.id === 'rebase-from-main') {
                      const merge = byId('rebase-to-main');
                      if (merge) { rows.push({ type: 'pair', left: action, right: merge }); continue; }
                    }
                    // Skip partners (they were already included in the pair above)
                    if (action.id === 'commit' || action.id === 'stash-pop' || action.id === 'push' || action.id === 'rebase-to-main') continue;
                  }
                  rows.push({ type: 'single', action });
                }
              }

              return rows.map(row => {
                if (row.type === 'pair') {
                  const { left, right } = row;
                  // Badge for pull/push
                  const leftBadge = left.id === 'pull' && behindCount > 0
                    ? <span className="text-[10px] text-status-warning font-medium ml-1">&darr;{behindCount}</span> : null;
                  const rightBadge = right.id === 'push' && aheadCount > 0
                    ? <span className="text-[10px] text-status-success font-medium ml-1">&uarr;{aheadCount}</span> : null;

                  const isRebaseMerge = left.id === 'rebase-from-main';
                  const mainBranchRaw = gitCommands?.mainBranch || 'main';
                  const mainBranch = mainBranchRaw.length > 6 ? mainBranchRaw.slice(0, 6) + '…' : mainBranchRaw;

                  const pairBtnClass = isRebaseMerge
                    ? 'flex-1 justify-start text-xs !px-2'
                    : 'flex-1 justify-start text-sm !px-2';
                  const pairIconClass = isRebaseMerge
                    ? 'w-3.5 h-3.5 mr-1 flex-shrink-0'
                    : 'w-4 h-4 mr-2 flex-shrink-0';

                  return (
                    <div key={`${left.id}-${right.id}`} className="flex gap-0.5 [&>*]:min-w-[90px]">
                      <Tooltip content={left.description} side="left">
                        <Button variant="ghost" size="sm" className={pairBtnClass} onClick={left.onClick} disabled={left.disabled || isMerging}>
                          <left.icon className={pairIconClass} />
                          {isRebaseMerge ? (
                            <span className="flex flex-col items-start leading-tight">
                              <span>Rebase</span>
                              <span className="text-[10px] text-text-tertiary">from {mainBranch}</span>
                            </span>
                          ) : left.id === 'fetch' && fetchedAgo ? (
                            <span className="flex flex-col items-start leading-tight min-w-0">
                              <span>{left.label}</span>
                              <span className="text-[10px] text-text-tertiary">{fetchedAgo}</span>
                            </span>
                          ) : (
                            <>
                              <span>{left.label}</span>
                              {leftBadge}
                            </>
                          )}
                        </Button>
                      </Tooltip>
                      <Tooltip content={right.description} side="left">
                        <Button variant="ghost" size="sm" className={pairBtnClass} onClick={right.onClick} disabled={right.disabled || isMerging}>
                          <right.icon className={pairIconClass} />
                          {isRebaseMerge ? (
                            <span className="flex flex-col items-start leading-tight">
                              <span>Merge</span>
                              <span className="text-[10px] text-text-tertiary">to {mainBranch}</span>
                            </span>
                          ) : right.id === 'commit' ? (
                            <span className="flex flex-col items-start leading-tight min-w-0">
                              <span>{right.label}</span>
                              <span className="text-[10px] text-text-tertiary truncate max-w-full">
                                {gitStatus?.filesChanged && gitStatus.filesChanged > 0
                                  ? `${gitStatus.filesChanged} ${gitStatus.filesChanged === 1 ? 'file' : 'files'}`
                                  : `to ${(() => { const b = gitCommands?.currentBranch?.trim() || 'branch'; return b.length > 6 ? b.slice(0, 6) + '…' : b; })()}`}
                              </span>
                            </span>
                          ) : (
                            <>
                              <span>{right.label}</span>
                              {rightBadge}
                            </>
                          )}
                        </Button>
                      </Tooltip>
                    </div>
                  );
                }

                const { action } = row;
                const isFetch = action.id === 'fetch';

                return (
                  <Tooltip key={action.id} content={action.description} side="left">
                    <Button variant="ghost" size="sm" className={sidebarBtn} onClick={action.onClick} disabled={action.disabled || isMerging}>
                      <action.icon className="w-4 h-4 mr-2 flex-shrink-0" />
                      {isFetch && fetchedAgo ? (
                        <span className="flex flex-col items-start leading-tight min-w-0">
                          <span>{action.label}</span>
                          <span className="text-xs text-text-tertiary">{fetchedAgo}</span>
                        </span>
                      ) : (
                        <span className="truncate">{action.label}</span>
                      )}
                    </Button>
                  </Tooltip>
                );
              });
            })()}

            {/* Project: Pull/Push */}
            {isProject && projectGitActions && (
              <>
                {projectGitActions.onPull && (
                  <Button variant="ghost" size="sm" className={sidebarBtn} onClick={projectGitActions.onPull} disabled={projectGitActions.isMerging}>
                    Pull
                  </Button>
                )}
                {projectGitActions.onPush && (
                  <Button variant="ghost" size="sm" className={sidebarBtn} onClick={projectGitActions.onPush} disabled={projectGitActions.isMerging}>
                    Push
                  </Button>
                )}
              </>
            )}
          </div>
        </DetailSection>
      </div>

      {/* History — fills remaining space, only this section scrolls */}
      {session.worktreePath && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="px-2 pt-2 flex-shrink-0">
            <SectionHeader>History</SectionHeader>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
            <GitHistoryGraph
              sessionId={session.id}
              baseBranch={session.baseBranch || 'main'}
            />
          </div>
        </div>
      )}
    </div>
  );
}
