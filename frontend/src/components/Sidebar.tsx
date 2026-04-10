import { useState, useEffect, useMemo, useCallback } from 'react';
import { Settings } from './Settings';
import { CreateSessionDialog } from './CreateSessionDialog';
import { ProjectSessionList, ArchivedSessions } from './ProjectSessionList';
import { ArchiveProgress } from './ArchiveProgress';
import { ArrowUpDown, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, Plus, RefreshCw } from 'lucide-react';
import { SessionDetailTooltip } from './SessionDetailTooltip';
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
import { usePanelStore } from '../stores/panelStore';
import { API } from '../utils/api';
import type { Project } from '../types/project';

// --- Collapsed sidebar tooltip content ---

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
  onHelpClick: () => void;
  onDocsClick: () => void;
}

const HelpCircleIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

export function Sidebar({ onAboutClick, onSettingsClick, isSettingsOpen, onSettingsClose, settingsInitialSection, width, onResize, collapsed, onToggleCollapse, onHelpClick, onDocsClick }: SidebarProps) {
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
  const activityStatus = usePanelStore(s => s.activityStatus);
  const panelsBySession = usePanelStore(s => s.panels);

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

          {/* Projects with their sessions */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden py-2 flex flex-col items-center gap-1.5">
            {projects.map((project) => {
              const isActiveProject = project.id === activeProject?.id;
              const initial = project.name.charAt(0).toUpperCase();
              const projectSessions = sessions.filter(s => s.projectId === project.id && !s.archived);
              return (
                <div key={project.id} className="flex flex-col items-center gap-0.5 w-full">
                  {/* Project initial */}
                  <Tooltip content={<CollapsedProjectTooltip project={project} sessionCount={projectSessions.length} />} side="right">
                    <button
                      onClick={() => navigateToProject(project.id)}
                      className={`w-8 h-8 rounded flex items-center justify-center text-xs font-semibold transition-colors ${
                        isActiveProject
                          ? 'bg-interactive/20 text-interactive ring-1 ring-interactive/50'
                          : 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary'
                      }`}
                    >
                      {initial}
                    </button>
                  </Tooltip>
                  {/* Session status badges — grouped under this project */}
                  {projectSessions.map((session) => {
                    const isActive = session.id === activeSessionId;
                    const sessionPanels = panelsBySession[session.id] || [];
                    const isSessionActive = sessionPanels.some(p => activityStatus[p.id] === 'active');
                    const statusColor = isSessionActive ? 'bg-status-warning opacity-100' : 'bg-text-muted/20 opacity-40';
                    const isAnimated = isSessionActive;
                    return (
                      <Tooltip key={session.id} content={<SessionDetailTooltip session={session} />} side="right">
                        <button
                          onClick={() => setActiveSession(session.id)}
                          className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                            isActive ? 'bg-interactive/20 ring-1 ring-interactive/50' : 'hover:bg-surface-hover'
                          }`}
                        >
                          {/**
                           * Session status badge — currently renders as a colored dot.
                           * TODO: Evolve into richer interactive badges with session identity
                           * (e.g., initials, mini name) and better click-to-navigate affordance.
                           */}
                          <div className={`w-2.5 h-2.5 rounded-full transition-all duration-500 ${statusColor} ${isAnimated ? 'animate-pulse' : ''}`} />
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
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
                  id: 'help',
                  label: 'Help',
                  icon: HelpCircleIcon,
                  onClick: onHelpClick
                },
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
              <div className="flex items-center justify-center gap-1.5 text-xs text-text-tertiary truncate">
                <span
                  className="cursor-pointer hover:text-text-secondary transition-colors"
                  onClick={onAboutClick}
                  title="Click to view version details"
                >
                  v{version}{worktreeName && ` \u00b7 ${worktreeName}`}{gitCommit && ` \u00b7 ${gitCommit}`}
                </span>
                <span className="text-border-primary">&middot;</span>
                <span
                  className="cursor-pointer hover:text-text-secondary transition-colors"
                  onClick={onDocsClick}
                  title="Open documentation"
                >
                  Docs
                </span>
              </div>
            </div>
          )}
        </div>
    </div>

      <Settings isOpen={isSettingsOpen} onClose={onSettingsClose} initialSection={settingsInitialSection} />
    </>
  );
}
