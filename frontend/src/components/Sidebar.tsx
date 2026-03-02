import { useState, useEffect, useMemo, useCallback } from 'react';
import { Settings } from './Settings';
import { CreateSessionDialog } from './CreateSessionDialog';
import { ProjectSessionList, ArchivedSessions } from './ProjectSessionList';
import { ArchiveProgress } from './ArchiveProgress';
import { Info, Check, Edit, CircleArrowDown, AlertTriangle, GitMerge, ArrowUpDown, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, Plus, Minus, RefreshCw, GitBranch, Clock, FileText, GitPullRequest } from 'lucide-react';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { isMac } from '../utils/platformUtils';
import { IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { Kbd } from './ui/Kbd';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { Modal, ModalHeader, ModalBody } from './ui/Modal';
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
              <p className="text-[10px] text-text-tertiary whitespace-pre-wrap break-words leading-snug pl-[18px] line-clamp-4">
                {gs.prBody}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface SidebarProps {
  onHelpClick: () => void;
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

export function Sidebar({ onHelpClick, onAboutClick, onSettingsClick, isSettingsOpen, onSettingsClose, settingsInitialSection, width, onResize, collapsed, onToggleCollapse }: SidebarProps) {
  const paneLogo = usePaneLogo();
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = useCallback((id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  }, [hotkeys]);
  const [showStatusGuide, setShowStatusGuide] = useState(false);
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
  if (collapsed) {
    return (
      <>
        <div
          data-testid="sidebar"
          className="bg-surface-primary text-text-primary h-full flex flex-col flex-shrink-0 border-r border-border-primary"
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
        className="bg-surface-primary text-text-primary h-full flex flex-col relative flex-shrink-0 border-r border-border-primary"
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
          {/* Visual indicator */}
          <div className="absolute inset-0 bg-border-secondary group-hover:bg-interactive transition-colors" />
          {/* Larger grab area */}
          <div className="absolute -left-2 -right-2 top-0 bottom-0" />
          {/* Drag indicator dots */}
          <div className="absolute top-1/2 -translate-y-1/2 right-0 transform translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="flex flex-col gap-1">
              <div className="w-1 h-1 bg-interactive rounded-full" />
              <div className="w-1 h-1 bg-interactive rounded-full" />
              <div className="w-1 h-1 bg-interactive rounded-full" />
            </div>
          </div>
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
            <IconButton
              onClick={onHelpClick}
              aria-label="Help"
              size="md"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <Tooltip content={hotkeyDisplay('open-settings') ? <Kbd>{hotkeyDisplay('open-settings')}</Kbd> : undefined} side="bottom">
              <IconButton
                onClick={onSettingsClick}
                aria-label="Settings"
                data-testid="settings-button"
                size="md"
                icon={
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                }
              />
            </Tooltip>
          </div>
        </div>


        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <div className="px-3 py-2 text-sm uppercase flex items-center justify-between overflow-hidden">
            <span className="truncate text-text-tertiary">Repos & Worktrees</span>
            <div className="flex items-center space-x-1">
              <Dropdown
                trigger={
                  <button className="p-1 rounded-md hover:bg-interactive/10 text-text-secondary hover:text-text-primary">
                    <MoreHorizontal size={14} />
                  </button>
                }
                items={[
                  {
                    id: 'sort',
                    label: sessionSortAscending ? 'Sort: Oldest first' : 'Sort: Newest first',
                    icon: ArrowUpDown,
                    onClick: toggleSessionSortOrder
                  },
                  {
                    id: 'legend',
                    label: 'Status legend',
                    icon: Info,
                    onClick: () => setShowStatusGuide(true)
                  },
                  {
                    id: 'refresh',
                    label: 'Refresh git status',
                    icon: RefreshCw,
                    onClick: handleRefreshGitStatus
                  }
                ] satisfies DropdownItem[]}
                position="auto"
                width="sm"
              />
            </div>
          </div>
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
      
      {/* Status Guide Modal */}
      <Modal 
        isOpen={showStatusGuide} 
        onClose={() => setShowStatusGuide(false)}
        size="lg"
      >
        <ModalHeader>Status Indicators Guide</ModalHeader>
        <ModalBody>
            
            <div className="space-y-4">
              {/* Project Indicators */}
              <div className="pb-3 border-b border-border-primary">
                <h4 className="text-sm font-medium text-text-primary mb-2">Project Indicators</h4>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <svg className="w-4 h-4 text-interactive" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path d="M6 3v12M6 3a9 9 0 0 0 9 9m-9-9a9 9 0 0 1 9 9m0-9h12" />
                    </svg>
                    <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-status-success rounded-full"></div>
                  </div>
                  <div>
                    <span className="text-text-secondary font-medium">Git Project</span>
                    <p className="text-text-tertiary text-sm">Project connected to a git repository</p>
                  </div>
                </div>
              </div>
              
              {/* Pane Status Indicators */}
              <div className="pb-3 border-b border-border-primary">
                <h4 className="text-sm font-medium text-text-primary mb-2">Pane Status</h4>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-success rounded-full animate-pulse flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Initializing</span>
                      <p className="text-text-tertiary text-sm">Setting up git worktree and environment</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-success rounded-full animate-pulse flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Running</span>
                      <p className="text-text-tertiary text-sm">Claude is actively processing your request</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-warning rounded-full animate-pulse flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Waiting</span>
                      <p className="text-text-tertiary text-sm">Claude needs your input to continue</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-neutral rounded-full flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Completed</span>
                      <p className="text-text-tertiary text-sm">Task finished successfully</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-info rounded-full animate-pulse flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">New Activity</span>
                      <p className="text-text-tertiary text-sm">Pane has new unviewed results</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-error rounded-full flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Error</span>
                      <p className="text-text-tertiary text-sm">Something went wrong with the pane</p>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Git Status Indicators */}
              <div>
                <h4 className="text-sm font-medium text-text-primary mb-2">Git Status Indicators</h4>
                <p className="text-text-tertiary text-sm mb-3">Click any indicator to view detailed changes in the Diff panel</p>
                
                {/* HIGH PRIORITY */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-text-tertiary mb-2">HIGH PRIORITY</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center gap-0.5 w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-status-success/10 text-status-success border-border-primary">
                        <GitMerge className="w-3.5 h-3.5" strokeWidth={2} />
                        <span className="font-bold">3</span>
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Ready to Merge</strong> - Changes ready to merge cleanly</span>
                    </div>
                    
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center gap-0.5 w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-status-warning/10 text-status-warning border-border-primary">
                        <AlertTriangle className="w-3.5 h-3.5" strokeWidth={2} />
                        <span className="font-bold">2</span>
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Conflict Risk</strong> - Behind main, potential conflicts</span>
                    </div>
                  </div>
                </div>
                
                {/* SPECIAL CASES */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-text-tertiary mb-2">SPECIAL CASES</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-status-error/10 text-status-error border-border-primary">
                        <AlertTriangle className="w-3.5 h-3.5" strokeWidth={2} />
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Conflicts</strong> - Active merge conflicts need resolution</span>
                    </div>
                    
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center gap-0.5 w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-status-info/10 text-status-info border-border-primary">
                        <Edit className="w-3.5 h-3.5" strokeWidth={2} />
                        <span className="font-bold">2</span>
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Uncommitted</strong> - Work in progress</span>
                    </div>
                  </div>
                </div>
                
                {/* LOW PRIORITY */}
                <div>
                  <p className="text-xs font-medium text-text-tertiary mb-2">LOW PRIORITY</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center gap-0.5 w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-bg-tertiary text-text-tertiary border-border-primary">
                        <CircleArrowDown className="w-3.5 h-3.5" strokeWidth={2} />
                        <span className="font-bold">2</span>
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Behind Only</strong> - No unique changes</span>
                    </div>
                    
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-bg-tertiary text-text-tertiary border-border-primary">
                        <Check className="w-3.5 h-3.5" strokeWidth={2} />
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Up to Date</strong> - Safe to remove</span>
                    </div>
                  </div>
                </div>
                
                <div className="mt-4 p-3 bg-status-info/10 border border-status-info/20 rounded-lg">
                  <p className="font-medium text-status-info text-xs mb-2">Tips</p>
                  <ul className="list-disc list-inside space-y-1 text-xs text-text-secondary">
                    <li>Focus on <strong>High Priority</strong> branches first</li>
                    <li>Numbers show commit count or file changes</li>
                    <li>Star (★) indicates counts above 9</li>
                    <li>Gray indicators are low priority - often safe to remove</li>
                    <li>Click any indicator to view detailed diff</li>
                  </ul>
                </div>
              </div>
            </div>
        </ModalBody>
      </Modal>
    </>
  );
}
