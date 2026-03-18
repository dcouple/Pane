import { useState, useEffect, useMemo, useCallback } from 'react';
import { Settings } from './Settings';
import { CreateSessionDialog } from './CreateSessionDialog';
import { ProjectSessionList, ArchivedSessions } from './ProjectSessionList';
import { ArchiveProgress } from './ArchiveProgress';
import { ArrowUpDown, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, Plus, Minus, RefreshCw, GitBranch, Clock, FileText, GitPullRequest } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { isMac } from '../utils/platformUtils';
import { IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { Kbd } from './ui/Kbd';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { Dropdown } from './ui/Dropdown';
import type { DropdownItem } from './ui/Dropdown';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { API } from '../utils/api';
import type { Project } from '../types/project';
import type { Session } from '../types/session';

// --- Collapsed sidebar tooltip content ---

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

function CollapsedProjectTooltip({ project, sessionCount }: { project: Project; sessionCount: number }) {
  return (
    <div className="max-w-xs space-y-1">
      <p className="text-[11px] text-text-primary font-medium">{project.name}</p>
      <p className="text-[10px] text-text-tertiary font-mono break-all">{project.path}</p>
      <p className="text-[10px] text-text-tertiary">
        {sessionCount} {sessionCount === 1 ? 'workspace' : 'workspaces'}
      </p>
    </div>
  );
}

function CollapsedSessionTooltip({ session }: { session: Session }) {
  const gs = session.gitStatus;
  const branch = session.worktreePath?.replace(/\\/g, '/').split('/').pop() || '';
  const createdDate = new Date(session.createdAt).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
  const lastActiveAgo = session.lastActivity ? formatTimeAgo(session.lastActivity) : null;

  let statusText = '';
  let statusColor = 'text-text-tertiary';
  if (session.status === 'running' || session.status === 'initializing') {
    statusText = session.status === 'initializing' ? 'Initializing' : 'Running';
    statusColor = 'text-status-success';
  } else if (session.status === 'waiting') {
    statusText = 'Waiting for input';
    statusColor = 'text-status-warning';
  } else if (session.status === 'error') {
    statusText = 'Error';
    statusColor = 'text-status-error';
  } else if (gs) {
    if (gs.state === 'conflict') { statusText = 'Merge conflicts'; statusColor = 'text-status-error'; }
    else if (gs.isReadyToMerge) { statusText = 'Ready to merge'; statusColor = 'text-status-success'; }
    else if (gs.hasUncommittedChanges) { statusText = 'Uncommitted'; statusColor = 'text-status-warning'; }
    else if (gs.state === 'diverged') { statusText = 'Diverged'; statusColor = 'text-status-warning'; }
    else if (gs.state === 'ahead' && gs.ahead) { statusText = `${gs.ahead} ahead`; statusColor = 'text-status-warning'; }
    else if (gs.state === 'behind' && gs.behind) { statusText = `${gs.behind} behind`; }
    else if (gs.state === 'clean') { statusText = 'Up to date'; }
  }

  const adds = (gs?.commitAdditions ?? 0) + (gs?.additions ?? 0);
  const dels = (gs?.commitDeletions ?? 0) + (gs?.deletions ?? 0);
  const hasDiff = adds > 0 || dels > 0;
  const filesChanged = (gs?.commitFilesChanged ?? 0) + (gs?.filesChanged ?? 0);

  return (
    <div className="max-w-xs space-y-1.5">
      <p className="text-[11px] text-text-primary font-medium whitespace-pre-wrap break-words leading-snug">
        {session.name || 'Untitled'}
      </p>

      <div className="border-t border-border-primary" />

      <div className="space-y-0.5 text-[10px]">
        {branch && (
          <div className="flex items-center gap-1.5">
            <GitBranch className="w-3 h-3 text-text-tertiary flex-shrink-0" />
            <span className="text-text-secondary font-mono break-all">{branch}</span>
          </div>
        )}
        {statusText && (
          <div className="flex items-center gap-1.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ml-[3px] ${
              statusColor.replace('text-', 'bg-')
            }`} />
            <span className={`${statusColor} ml-[3px]`}>{statusText}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-text-tertiary flex-shrink-0" />
          <span className="text-text-secondary">
            {createdDate}
            {lastActiveAgo && <span className="text-text-tertiary"> · active {lastActiveAgo}</span>}
          </span>
        </div>
      </div>

      {hasDiff && (
        <>
          <div className="border-t border-border-primary" />
          <div className="flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1 text-text-secondary">
              <FileText className="w-3 h-3 text-text-tertiary" />
              {filesChanged} {filesChanged === 1 ? 'file' : 'files'}
            </span>
            {adds > 0 && (
              <span className="flex items-center gap-0.5 text-status-success">
                <Plus className="w-3 h-3" />{adds}
              </span>
            )}
            {dels > 0 && (
              <span className="flex items-center gap-0.5 text-status-error">
                <Minus className="w-3 h-3" />{dels}
              </span>
            )}
          </div>
        </>
      )}

      {gs?.prNumber && (
        <>
          <div className="border-t border-border-primary" />
          <div className="space-y-1 text-[10px]">
            <div className="flex items-center gap-1.5">
              <GitPullRequest className="w-3 h-3 text-text-tertiary flex-shrink-0" />
              <span className="text-text-secondary font-medium">
                #{gs.prNumber}
                {gs.prState && (
                  <span className={`ml-1 ${
                    gs.prState === 'MERGED' ? 'text-purple-400' :
                    gs.prState === 'CLOSED' ? 'text-red-400' :
                    'text-green-400'
                  }`}>
                    {gs.prState.charAt(0) + gs.prState.slice(1).toLowerCase()}
                  </span>
                )}
              </span>
            </div>
            {gs.prTitle && (
              <p className="text-[11px] text-text-primary font-medium whitespace-pre-wrap break-words leading-snug pl-[18px]">
                {gs.prTitle}
              </p>
            )}
            {gs.prBody && (
              <div className="text-[10px] text-text-tertiary break-words leading-snug pl-[18px] line-clamp-[32] prose prose-xs prose-invert max-w-none [&_h1]:text-[11px] [&_h2]:text-[11px] [&_h3]:text-[10px] [&_p]:text-[10px] [&_li]:text-[10px] [&_code]:text-[9px] [&_ul]:my-0.5 [&_ol]:my-0.5 [&_p]:my-0.5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{gs.prBody}</ReactMarkdown>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface SidebarProps {
  onAboutClick: () => void;
  onSettingsClick: () => void;
  isSettingsOpen: boolean;
  onSettingsClose: () => void;
  settingsInitialSection?: string;
  width: number;
  onResize: (e: React.MouseEvent) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ onAboutClick, onSettingsClick, isSettingsOpen, onSettingsClose, settingsInitialSection, width, onResize, collapsed, onToggleCollapse }: SidebarProps) {
  const paneLogo = usePaneLogo();
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = useCallback((id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  }, [hotkeys]);
  const [version, setVersion] = useState<string>('');
  const [gitCommit, setGitCommit] = useState<string>('');
  const [worktreeName, setWorktreeName] = useState<string>('');
  const [sessionSortAscending, setSessionSortAscending] = useState<boolean>(true); // Default to ascending (newest at bottom)

  useEffect(() => {
    // Fetch version info and UI state on component mount
    const fetchVersion = async () => {
      try {
        console.log('[Sidebar Debug] Fetching version info...');
        const result = await window.electronAPI.getVersionInfo();
        console.log('[Sidebar Debug] Version info result:', result);
        if (result.success && result.data) {
          console.log('[Sidebar Debug] Version data:', result.data);
          if (result.data.current) {
            setVersion(result.data.current);
            console.log('[Sidebar Debug] Set version:', result.data.current);
          }
          if (result.data.gitCommit) {
            setGitCommit(result.data.gitCommit);
            console.log('[Sidebar Debug] Set gitCommit:', result.data.gitCommit);
          }
          if (result.data.worktreeName) {
            setWorktreeName(result.data.worktreeName);
            console.log('[Sidebar Debug] Set worktreeName:', result.data.worktreeName);
          } else {
            console.log('[Sidebar Debug] No worktreeName in response');
          }
        }
      } catch (error) {
        console.error('Failed to fetch version:', error);
      }
    };

    const loadUIState = async () => {
      try {
        const result = await window.electronAPI.uiState.getExpanded();
        if (result.success && result.data) {
          setSessionSortAscending(result.data.sessionSortAscending ?? true);
        }
      } catch (error) {
        console.error('Failed to load UI state:', error);
      }
    };

    fetchVersion();
    loadUIState();
  }, []);

  const toggleSessionSortOrder = async () => {
    const newValue = !sessionSortAscending;
    setSessionSortAscending(newValue);

    // Save to database via electronAPI
    try {
      await window.electronAPI.uiState.saveSessionSortAscending(newValue);
    } catch (error) {
      console.error('Failed to save session sort order:', error);
    }
  };

  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);

  // State for collapsed sidebar
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const activeProjectId = useNavigationStore((state) => state.activeProjectId);
  const navigateToProject = useNavigationStore((state) => state.navigateToProject);

  const handleRefreshGitStatus = async () => {
    try {
      if (activeProjectId) {
        await window.electronAPI.projects.refreshGitStatus(activeProjectId);
      }
    } catch (error) {
      console.error('Failed to refresh git status:', error);
    }
  };

  // Fetch projects for collapsed sidebar
  useEffect(() => {
    if (!collapsed) return;
    const fetchProjects = async () => {
      try {
        const response = await API.projects.getAll();
        if (response.success && response.data) {
          setProjects(response.data);
        }
      } catch (error) {
        console.error('Failed to fetch projects:', error);
      }
    };
    fetchProjects();
  }, [collapsed]);

  const activeProject = useMemo(() => {
    if (activeProjectId) return projects.find(p => p.id === activeProjectId);
    return projects.find(p => p.active) || projects[0];
  }, [projects, activeProjectId]);

  // Collapsed sidebar view
  const immersiveMode = useNavigationStore(s => s.immersiveMode);
  if (collapsed || immersiveMode) {
    return (
      <>
        <div
          data-testid="sidebar"
          className="pane-sidebar-shell pane-sidebar-shell-collapsed bg-surface-primary text-text-primary h-full flex flex-col flex-shrink-0 border-r border-border-primary"
          style={{ width: '48px' }}
        >
          {/* Drag handle for window (not needed on macOS — handled by App-level spacer) */}
          {!isMac() && (
            <div className="h-3 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
          )}
          {/* Logo */}
          <div className="flex items-center justify-center px-1 py-2 border-b border-border-primary">
            <img src={paneLogo} alt="Pane" className="h-6 w-6" />
          </div>

          {/* Project selector */}
          <div className="flex flex-col items-center gap-1 py-2 border-b border-border-primary">
            {projects.map((project) => {
              const isActive = project.id === activeProject?.id;
              const initial = project.name.charAt(0).toUpperCase();
              const projectSessionCount = sessions.filter(s => s.projectId === project.id && !s.archived).length;
              return (
                <Tooltip key={project.id} content={<CollapsedProjectTooltip project={project} sessionCount={projectSessionCount} />} side="right">
                  <button
                    onClick={() => navigateToProject(project.id)}
                    className={`w-8 h-8 rounded flex items-center justify-center text-xs font-semibold transition-colors ${
                      isActive
                        ? 'bg-interactive/20 text-interactive ring-1 ring-interactive/50'
                        : 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary'
                    }`}
                  >
                    {initial}
                  </button>
                </Tooltip>
              );
            })}
          </div>

          {/* Session dots + new session button */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden py-2 flex flex-col items-center gap-1">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const statusColor = session.status === 'running' || session.status === 'initializing'
                ? 'bg-status-success'
                : session.status === 'waiting'
                ? 'bg-status-warning'
                : session.status === 'error'
                ? 'bg-status-error'
                : 'bg-status-neutral';
              const isAnimated = session.status === 'running' || session.status === 'initializing' || session.status === 'waiting';
              return (
                <Tooltip key={session.id} content={<CollapsedSessionTooltip session={session} />} side="right">
                  <button
                    onClick={() => setActiveSession(session.id)}
                    className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                      isActive ? 'bg-interactive/20 ring-1 ring-interactive/50' : 'hover:bg-surface-hover'
                    }`}
                  >
                    <div className={`w-2.5 h-2.5 rounded-full ${statusColor} ${isAnimated ? 'animate-pulse' : ''}`} />
                  </button>
                </Tooltip>
              );
            })}
            {/* New session button */}
            {activeProject && (
              <button
                onClick={() => setShowCreateDialog(true)}
                className="w-8 h-8 rounded flex items-center justify-center text-text-tertiary hover:bg-surface-hover hover:text-interactive transition-colors"
                title="New Pane"
              >
                <Plus className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Bottom actions */}
          <div className="flex-shrink-0 flex flex-col items-center gap-1 py-2 border-t border-border-primary">
            <Tooltip content={hotkeyDisplay('open-settings') ? <Kbd>{hotkeyDisplay('open-settings')}</Kbd> : undefined} side="right">
              <IconButton
                onClick={onSettingsClick}
                aria-label="Settings"
                size="sm"
                icon={<SettingsIcon className="w-4 h-4" />}
              />
            </Tooltip>
            <Tooltip content={hotkeyDisplay('toggle-sidebar') ? <Kbd>{hotkeyDisplay('toggle-sidebar')}</Kbd> : undefined} side="right">
              <IconButton
                onClick={onToggleCollapse}
                aria-label="Expand sidebar"
                size="sm"
                icon={<PanelLeftOpen className="w-4 h-4" />}
              />
            </Tooltip>
          </div>
        </div>

        <Settings isOpen={isSettingsOpen} onClose={onSettingsClose} initialSection={settingsInitialSection} />
        {showCreateDialog && activeProject && (
          <CreateSessionDialog
            isOpen={showCreateDialog}
            onClose={() => setShowCreateDialog(false)}
            projectName={activeProject.name}
            projectId={activeProject.id}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div
        data-testid="sidebar"
        className="pane-sidebar-shell bg-surface-primary text-text-primary h-full flex flex-col relative flex-shrink-0 border-r border-border-primary"
        style={{ width: `${width}px` }}
      >
        {/* Drag handle for window (not needed on macOS — handled by App-level spacer) */}
        {!isMac() && (
          <div className="h-3 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        )}
        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize group z-10"
          onMouseDown={onResize}
        >
          {/* Larger grab area */}
          <div className="absolute -left-2 -right-2 top-0 bottom-0" />
        </div>
        <div className="px-3 py-2 border-b border-border-primary flex items-center justify-between overflow-hidden">
          <div className="flex items-center space-x-2 min-w-0">
            <img src={paneLogo} alt="Pane" className="h-6 w-6 flex-shrink-0" />
            <h1 className="text-xl font-bold truncate">Pane</h1>
          </div>
          <div className="flex items-center space-x-2 flex-shrink-0">
            {onToggleCollapse && (
              <Tooltip content={hotkeyDisplay('toggle-sidebar') ? <Kbd>{hotkeyDisplay('toggle-sidebar')}</Kbd> : undefined} side="bottom">
                <IconButton
                  onClick={onToggleCollapse}
                  aria-label="Collapse sidebar"
                  size="md"
                  icon={<PanelLeftClose className="w-5 h-5" />}
                />
              </Tooltip>
            )}
            <Dropdown
              trigger={
                <button
                  className="p-1 rounded-md hover:bg-interactive/10 text-text-secondary hover:text-text-primary"
                  aria-label="Sidebar menu"
                >
                  <MoreHorizontal size={14} />
                </button>
              }
              items={[
                {
                  id: 'settings',
                  label: 'Settings',
                  icon: SettingsIcon,
                  onClick: onSettingsClick
                },
                {
                  id: 'sort',
                  label: sessionSortAscending ? 'Sort: Oldest first' : 'Sort: Newest first',
                  icon: ArrowUpDown,
                  onClick: toggleSessionSortOrder
                },
                {
                  id: 'refresh',
                  label: 'Refresh git status',
                  icon: RefreshCw,
                  onClick: handleRefreshGitStatus
                }
              ] satisfies DropdownItem[]}
              position="bottom-right"
              width="sm"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <ProjectSessionList sessionSortAscending={sessionSortAscending} />
        </div>

        {/* Archived sessions - pinned above bottom */}
        <div className="flex-shrink-0">
          <ArchivedSessions />
        </div>

        {/* Bottom section - always visible */}
        <div className="flex-shrink-0">
          {/* Archive progress indicator above version */}
          <ArchiveProgress />

          {/* Version display at bottom */}
          {version && (
            <div className="px-3 py-2 border-t border-border-primary">
              <div
                className="text-xs text-text-tertiary text-center cursor-pointer hover:text-text-secondary transition-colors truncate"
                onClick={onAboutClick}
                title="Click to view version details"
              >
                v{version}{worktreeName && ` • ${worktreeName}`}{gitCommit && ` • ${gitCommit}`}
              </div>
            </div>
          )}
        </div>
    </div>

      <Settings isOpen={isSettingsOpen} onClose={onSettingsClose} initialSection={settingsInitialSection} />
    </>
  );
}
