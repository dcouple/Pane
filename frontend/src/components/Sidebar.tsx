import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CreateSessionDialog } from './CreateSessionDialog';
import { ProjectSessionList, ArchivedSessions } from './ProjectSessionList';
import { ArchiveProgress } from './ArchiveProgress';
import { Archive, ArrowUpDown, ChevronDown, ChevronRight, Cpu, FolderGit2, Home, LayoutGrid, Monitor, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pin, Settings as SettingsIcon, Plus, RefreshCw, MessageSquare, SquareTerminal } from 'lucide-react';
import { SessionDetailTooltip } from './SessionDetailTooltip';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { Kbd } from './ui/Kbd';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { Dropdown } from './ui/Dropdown';
import type { DropdownItem } from './ui/Dropdown';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { SessionStatusBadge } from './SessionStatusBadge';
import { AgentActivityDot, AgentStatusDot } from './ui/AgentStatusDot';
import { useSessionAgentDisplayStatus } from '../hooks/useAgentStatus';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';
import { API } from '../utils/api';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import { useSessionNavigationHotkeys } from '../hooks/useSessionNavigationHotkeys';
import { useResourceMonitor } from '../hooks/useResourceMonitor';
import {
  createDefaultRemoteDaemonHostRuntimeState,
  createDefaultRemotePaneConnectionState,
  type RemoteDaemonHostRuntimeState,
  type RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';
import { getRemoteFooterStatus } from '../utils/remoteRuntimePresentation';
import { usePanelStore } from '../stores/panelStore';
import { rollupAgentDisplayStatus, rollupSessionAgentState, toAgentDisplayStatus } from '../utils/agentStatus';
import { createProjectById, getPinnedSessions, groupSessionsByProject } from '../utils/sessionOrdering';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';

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

function CompactSessionTooltip({
  session,
  label,
}: {
  session: Session;
  label: string;
}) {
  return (
    <div className="max-w-xs space-y-1.5">
      <p className="text-[11px] font-medium leading-snug text-text-primary whitespace-pre-wrap break-words">
        {label}
      </p>
      <div className="border-t border-border-primary" />
      <SessionDetailTooltip session={session} showName={false} />
    </div>
  );
}

interface SidebarProps {
  onAboutClick: () => void;
  onSettingsClick: () => void;
  onRemoteSettingsClick: () => void;
  width: number;
  onResize: (e: React.MouseEvent) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onHelpClick: () => void;
  onDocsClick: () => void;
  onFeedbackClick: () => void;
}

const REMOTE_DESKTOP_URL = 'https://remotedesktop.google.com/access';
const REMOTE_DESKTOP_TOOLTIP = 'Use Remote Desktop to access the host device for Electron apps, native windows, and UI running on the remote machine.';
const RESOURCE_POPOVER_WIDTH = 320;
const RESOURCE_POPOVER_GAP = 8;
const RESOURCE_POPOVER_VIEWPORT_MARGIN = 8;
type SidebarSection = 'pinned' | 'repositories';
interface CompactSessionMenuState {
  session: Session;
  x: number;
  y: number;
}
const COMPACT_RAIL_BUTTON = 'relative flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded transition-colors focus:outline-none focus:ring-2 focus:ring-interactive';
const COMPACT_RAIL_IDLE = 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary';
const COMPACT_RAIL_ACTIVE = 'bg-surface-hover text-text-primary';

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(mb * 1024)} KB`;
}

const HelpCircleIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

export function Sidebar({ onAboutClick, onSettingsClick, onRemoteSettingsClick, width, onResize, collapsed, onToggleCollapse, onHelpClick, onDocsClick, onFeedbackClick }: SidebarProps) {
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
  const [sidebarSectionExpansion, setSidebarSectionExpansion] = useState<Record<SidebarSection, boolean>>({
    pinned: true,
    repositories: true,
  });
  const [remoteConnectionState, setRemoteConnectionState] = useState<RemotePaneConnectionState>(createDefaultRemotePaneConnectionState());
  const [remoteHostState, setRemoteHostState] = useState<RemoteDaemonHostRuntimeState>(createDefaultRemoteDaemonHostRuntimeState());
  const resourceMenuButtonRef = useRef<HTMLButtonElement>(null);
  const resourcePopoverRef = useRef<HTMLDivElement>(null);
  const [showResourcePopover, setShowResourcePopover] = useState(false);
  const [resourcePopoverStyle, setResourcePopoverStyle] = useState<React.CSSProperties>({});
  const [expandedResourceSections, setExpandedResourceSections] = useState<Set<string>>(new Set(['pane-app']));
  const { snapshot, isLoading: resourceLoading, startActive, stopActive, refresh } = useResourceMonitor();
  const hydrateExpandedProjects = useNavigationStore(s => s.hydrateExpandedProjects);

  useEffect(() => {
    let cancelled = false;

    // Fetch version info and UI state on component mount
    const fetchVersion = async () => {
      try {
        const result = await window.electronAPI.getVersionInfo();
        if (cancelled) return;
        if (result.success && result.data) {
          if (result.data.current) {
            setVersion(result.data.current);
          }
          if (result.data.gitCommit) {
            setGitCommit(result.data.gitCommit);
          }
          if (result.data.worktreeName) {
            setWorktreeName(result.data.worktreeName);
          }
        }
      } catch (error) {
        console.error('Failed to fetch version:', error);
      }
    };

    const loadUIState = async () => {
      try {
        const result = await window.electronAPI.uiState.getExpanded();
        if (cancelled) return;
        if (result.success && result.data) {
          setSessionSortAscending(result.data.sessionSortAscending ?? true);
          hydrateExpandedProjects(result.data.expandedProjects ?? []);
          setSidebarSectionExpansion({
            pinned: result.data.pinnedSectionExpanded ?? true,
            repositories: result.data.repositoriesSectionExpanded ?? true,
          });
        }
      } catch (error) {
        console.error('Failed to load UI state:', error);
      }
    };

    void fetchVersion();
    void loadUIState();

    return () => {
      cancelled = true;
    };
  }, [hydrateExpandedProjects]);

  useEffect(() => {
    let cancelled = false;

    const fetchRemoteState = async () => {
      try {
        const [connectionResponse, hostResponse] = await Promise.all([
          API.remoteDaemon.getConnectionState(),
          API.remoteDaemon.getHostState(),
        ]);

        if (!cancelled && connectionResponse.success && connectionResponse.data) {
          setRemoteConnectionState(connectionResponse.data);
        }
        if (!cancelled && hostResponse.success && hostResponse.data) {
          setRemoteHostState(hostResponse.data);
        }
      } catch (error) {
        console.error('Failed to fetch remote runtime state:', error);
      }
    };

    const unsubscribeConnectionState = API.remoteDaemon.onConnectionStateChanged(setRemoteConnectionState);
    const unsubscribeHostState = API.remoteDaemon.onHostStateChanged(setRemoteHostState);
    void fetchRemoteState();

    return () => {
      cancelled = true;
      unsubscribeConnectionState();
      unsubscribeHostState();
    };
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

  const handleSidebarSectionExpandedChange = useCallback((section: SidebarSection, expanded: boolean) => {
    setSidebarSectionExpansion(prev => ({
      ...prev,
      [section]: expanded,
    }));

    void window.electronAPI.uiState.saveSidebarSectionExpanded(section, expanded).catch(error => {
      console.error('Failed to save sidebar section expanded state:', error);
    });
  }, []);

  const handlePinnedSectionExpandedChange = useCallback((expanded: boolean) => {
    handleSidebarSectionExpandedChange('pinned', expanded);
  }, [handleSidebarSectionExpandedChange]);

  const handleRepositoriesSectionExpandedChange = useCallback((expanded: boolean) => {
    handleSidebarSectionExpandedChange('repositories', expanded);
  }, [handleSidebarSectionExpandedChange]);

  const openResourcePopover = useCallback(() => {
    setShowResourcePopover(true);
    void refresh();
    startActive();
  }, [refresh, startActive]);

  const closeResourcePopover = useCallback((restoreFocus = false) => {
    setShowResourcePopover(false);
    stopActive();
    if (restoreFocus) {
      requestAnimationFrame(() => resourceMenuButtonRef.current?.focus());
    }
  }, [stopActive]);

  const toggleResourceSection = useCallback((id: string) => {
    setExpandedResourceSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleResourceRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!showResourcePopover || !resourceMenuButtonRef.current) return;

    const updatePosition = () => {
      if (!resourceMenuButtonRef.current) return;
      const rect = resourceMenuButtonRef.current.getBoundingClientRect();
      const popoverWidth = Math.min(
        RESOURCE_POPOVER_WIDTH,
        window.innerWidth - RESOURCE_POPOVER_VIEWPORT_MARGIN * 2,
      );
      const rightSideLeft = rect.right + RESOURCE_POPOVER_GAP;
      const leftSideLeft = rect.left - RESOURCE_POPOVER_GAP - popoverWidth;
      const maxLeft = window.innerWidth - popoverWidth - RESOURCE_POPOVER_VIEWPORT_MARGIN;
      const left = rightSideLeft <= maxLeft
        ? rightSideLeft
        : Math.max(RESOURCE_POPOVER_VIEWPORT_MARGIN, leftSideLeft);

      setResourcePopoverStyle({
        position: 'fixed',
        top: rect.bottom + 8,
        left: Math.min(left, maxLeft),
        zIndex: 10000,
        // Hangs below the trigger; grow out of that corner.
        transformOrigin: 'top left',
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [showResourcePopover]);

  useEffect(() => {
    if (!showResourcePopover) return;

    const focusFrame = requestAnimationFrame(() => {
      resourcePopoverRef.current
        ?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')
        ?.focus();
    });

    const handleClickOutside = (event: MouseEvent) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      const target = event.target as Node;
      if (
        resourceMenuButtonRef.current && !resourceMenuButtonRef.current.contains(target) &&
        resourcePopoverRef.current && !resourcePopoverRef.current.contains(target)
      ) {
        closeResourcePopover();
      }
    };

    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => {
      cancelAnimationFrame(focusFrame);
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showResourcePopover, closeResourcePopover]);

  useEffect(() => {
    if (!showResourcePopover) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeResourcePopover(true);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showResourcePopover, closeResourcePopover]);

  const electronTotalCpu = useMemo(
    () => snapshot?.electronProcesses.reduce((sum, p) => sum + p.cpuPercent, 0) ?? 0,
    [snapshot],
  );

  const electronTotalMem = useMemo(
    () => snapshot?.electronProcesses.reduce((sum, p) => sum + p.memoryMB, 0) ?? 0,
    [snapshot],
  );

  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const remoteFooterStatus = useMemo(
    () => getRemoteFooterStatus(remoteConnectionState, remoteHostState),
    [remoteConnectionState, remoteHostState],
  );
  const remoteFooterTooltip = (
    <div className="max-w-[260px] space-y-1">
      <p className="text-[11px] font-medium text-text-primary">{remoteFooterStatus.title}</p>
      <p className="text-[10px] text-text-tertiary">{remoteFooterStatus.description}</p>
    </div>
  );
  const showRemoteDesktopLink = remoteConnectionState.mode === 'remote' && remoteConnectionState.status === 'connected';
  const handleOpenRemoteDesktop = useCallback(() => {
    void window.electronAPI.openExternal(REMOTE_DESKTOP_URL).catch(error => {
      console.error('Failed to open Remote Desktop:', error);
    });
  }, []);

  // State for collapsed sidebar
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [compactSessionMenu, setCompactSessionMenu] = useState<CompactSessionMenuState | null>(null);
  const activeProjectId = useNavigationStore((state) => state.activeProjectId);
  const activeView = useNavigationStore((state) => state.activeView);
  const expandedProjects = useNavigationStore((state) => state.expandedProjects);
  const navigateToProject = useNavigationStore((state) => state.navigateToProject);
  const navigateToSessions = useNavigationStore((state) => state.navigateToSessions);
  const navigateToPaneChat = useNavigationStore((state) => state.navigateToPaneChat);
  const navigateToMissionControl = useNavigationStore((state) => state.navigateToMissionControl);
  const paneChatStatus = useSessionAgentDisplayStatus(PANE_CHAT_SESSION_ID);
  const setSidebarNavigationScope = useNavigationStore((state) => state.setSidebarNavigationScope);
  const agentStatusByPanel = usePanelStore((state) => state.agentStatus);
  const agentPanelSessions = usePanelStore((state) => state.agentStatusSession);
  /** Agents waiting on the user, anywhere — surfaced on the Mission Control rail button. */
  const blockedAgentCount = useMemo(
    () => Object.values(agentStatusByPanel).filter((state) => state === 'blocked').length,
    [agentStatusByPanel]
  );
  const unviewedBySession = usePanelStore((state) => state.unviewedCompletedActivity);
  useSessionNavigationHotkeys({ projects, sessionSortAscending });

  const handleRefreshGitStatus = async () => {
    try {
      if (activeProjectId) {
        await window.electronAPI.projects.refreshGitStatus(activeProjectId);
      }
    } catch (error) {
      console.error('Failed to refresh git status:', error);
    }
  };

  const loadProjects = useCallback(async () => {
    try {
      const response = await API.projects.getAll();
      if (response.success && response.data) {
        setProjects(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  }, []);

  // Fetch projects for collapsed sidebar rendering and always-mounted session hotkeys.
  useEffect(() => {
    loadProjects();
    window.addEventListener('project-changed', loadProjects);
    window.addEventListener('project-sessions-refresh', loadProjects);
    return () => {
      window.removeEventListener('project-changed', loadProjects);
      window.removeEventListener('project-sessions-refresh', loadProjects);
    };
  }, [loadProjects]);

  const activeProject = useMemo(() => {
    if (activeProjectId) return projects.find(p => p.id === activeProjectId);
    return projects.find(p => p.active) || projects[0];
  }, [projects, activeProjectId]);

  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sessions, sessionSortAscending),
    [sessions, sessionSortAscending],
  );
  const projectById = useMemo(() => createProjectById(projects), [projects]);
  const pinnedSessions = useMemo(
    () => getPinnedSessions(sessions, projectById),
    [sessions, projectById],
  );

  const openCompactSession = useCallback((sessionId: string, scope: 'pinned' | 'repositories') => {
    setCompactSessionMenu(null);
    setSidebarNavigationScope(scope);
    void setActiveSession(sessionId);
    navigateToSessions();
  }, [navigateToSessions, setActiveSession, setSidebarNavigationScope]);

  const openCompactSessionMenu = useCallback((event: React.MouseEvent, session: Session) => {
    event.preventDefault();
    event.stopPropagation();
    setCompactSessionMenu({ session, x: event.clientX, y: event.clientY });
  }, []);

  const archiveCompactSession = useCallback(async () => {
    if (!compactSessionMenu) return;
    const { id } = compactSessionMenu.session;
    setCompactSessionMenu(null);
    try {
      await API.sessions.delete(id);
    } catch (error) {
      console.error('Failed to archive session:', error);
    }
  }, [compactSessionMenu]);

  const toggleCompactSessionPinned = useCallback(async () => {
    if (!compactSessionMenu) return;
    const { id } = compactSessionMenu.session;
    setCompactSessionMenu(null);
    try {
      await API.sessions.toggleFavorite(id);
    } catch (error) {
      console.error('Failed to toggle pinned session:', error);
    }
  }, [compactSessionMenu]);

  // Collapsed sidebar view
  if (collapsed) {
    return (
      <>
        <div
          data-testid="sidebar"
          className="pane-sidebar-shell pane-sidebar-shell-collapsed bg-surface-primary text-text-primary h-full flex flex-col flex-shrink-0"
          style={{ width: '48px' }}
        >
          {/* Logo */}
          <div className="flex shrink-0 items-center justify-center border-b border-border-primary px-1 py-2">
            <img src={paneLogo} alt="Pane" className="h-6 w-6" />
          </div>

          <div className="flex shrink-0 flex-col items-center gap-1 border-b border-border-primary py-2">
            <Tooltip content="Home" side="right">
              <button
                type="button"
                data-compact-rail-item
                onClick={() => {
                  setSidebarNavigationScope('repositories');
                  void setActiveSession(null);
                  navigateToSessions();
                }}
                aria-label="Home"
                className={`${COMPACT_RAIL_BUTTON} ${activeView === 'sessions' && !activeSessionId ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
              >
                <Home className="h-4 w-4" />
              </button>
            </Tooltip>

            <Tooltip content="Pane Chat" side="right">
              <button
                type="button"
                data-testid="compact-pane-chat"
                data-compact-rail-item
                onClick={() => {
                  setSidebarNavigationScope('repositories');
                  void setActiveSession(null);
                  navigateToPaneChat();
                }}
                aria-label="Pane Chat"
                className={`${COMPACT_RAIL_BUTTON} ${activeView === 'pane-chat' ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
              >
                <MessageSquare className="h-4 w-4" />
                <AgentStatusDot status={paneChatStatus} size="sm" className="absolute right-0 top-0" />
              </button>
            </Tooltip>

            <Tooltip content="Mission Control" side="right">
              <button
                type="button"
                data-testid="compact-mission-control"
                data-compact-rail-item
                onClick={() => {
                  setSidebarNavigationScope('repositories');
                  navigateToMissionControl();
                }}
                aria-label={blockedAgentCount > 0
                  ? `Mission Control — ${blockedAgentCount} waiting for input`
                  : 'Mission Control'}
                className={`${COMPACT_RAIL_BUTTON} ${activeView === 'mission-control' ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
              >
                <LayoutGrid className="h-4 w-4" />
                {/* Same affordance as Pane Chat above: an agent is waiting. */}
                {blockedAgentCount > 0 && (
                  <AgentStatusDot status="blocked" size="sm" className="absolute right-0 top-0" />
                )}
              </button>
            </Tooltip>

            {showRemoteDesktopLink && (
              <Tooltip content={REMOTE_DESKTOP_TOOLTIP} side="right">
                <button
                  type="button"
                  data-compact-rail-item
                  onClick={handleOpenRemoteDesktop}
                  aria-label="Open Remote Desktop"
                  className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
                >
                  <Monitor className="h-4 w-4" />
                </button>
              </Tooltip>
            )}
          </div>

          <nav
            aria-label="Compact sidebar"
            className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden py-2"
          >
            {pinnedSessions.length > 0 && (
              <div role="group" aria-label="Pinned panes" className="flex w-full shrink-0 flex-col items-center gap-0.5">
                <Tooltip content={`${sidebarSectionExpansion.pinned ? 'Collapse' : 'Expand'} pinned panes`} side="right">
                  <button
                    type="button"
                    data-testid="compact-pinned-toggle"
                    data-compact-rail-item
                    onClick={() => handlePinnedSectionExpandedChange(!sidebarSectionExpansion.pinned)}
                    aria-label={`${sidebarSectionExpansion.pinned ? 'Collapse' : 'Expand'} pinned panes`}
                    aria-expanded={sidebarSectionExpansion.pinned}
                    className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
                  >
                    <Pin className="h-4 w-4" />
                    {sidebarSectionExpansion.pinned
                      ? <ChevronDown className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />
                      : <ChevronRight className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />}
                  </button>
                </Tooltip>

                {sidebarSectionExpansion.pinned && pinnedSessions.map(({ session, label }) => (
                  <Tooltip
                    key={`compact-pinned-${session.id}`}
                    content={<CompactSessionTooltip session={session} label={label} />}
                    side="right"
                    interactive
                  >
                    <button
                      type="button"
                      data-testid={`compact-pinned-pane-${session.id}`}
                      data-compact-rail-item
                      onClick={() => openCompactSession(session.id, 'pinned')}
                      onContextMenu={(event) => openCompactSessionMenu(event, session)}
                      aria-label={`Open pinned pane ${label}`}
                      className={`${COMPACT_RAIL_BUTTON} ${session.id === activeSessionId && activeView === 'sessions' ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
                    >
                      <SessionStatusBadge
                        sessionId={session.id}
                        unknownFallback={(
                          <SquareTerminal
                            data-testid={`compact-pinned-pane-placeholder-${session.id}`}
                            aria-hidden="true"
                            className="h-4 w-4 text-text-tertiary"
                          />
                        )}
                      />
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}

            <div role="group" aria-label="Repositories" className="flex w-full shrink-0 flex-col items-center gap-0.5">
              <Tooltip content={`${sidebarSectionExpansion.repositories ? 'Collapse' : 'Expand'} repositories`} side="right">
                <button
                  type="button"
                  data-testid="compact-repositories-toggle"
                  data-compact-rail-item
                  onClick={() => handleRepositoriesSectionExpandedChange(!sidebarSectionExpansion.repositories)}
                  aria-label={`${sidebarSectionExpansion.repositories ? 'Collapse' : 'Expand'} repositories`}
                  aria-expanded={sidebarSectionExpansion.repositories}
                  className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
                >
                  <FolderGit2 className="h-4 w-4" />
                  {sidebarSectionExpansion.repositories
                    ? <ChevronDown className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />
                    : <ChevronRight className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />}
                </button>
              </Tooltip>

              {sidebarSectionExpansion.repositories && projects.map((project) => {
                const isActiveProject = project.id === activeProject?.id && activeView === 'project';
                const initial = project.name.charAt(0).toUpperCase();
                const projectSessions = sessionsByProject.get(project.id) ?? [];
                const projectAgentState = rollupAgentDisplayStatus(
                  projectSessions.map(session => toAgentDisplayStatus(
                    rollupSessionAgentState(agentStatusByPanel, agentPanelSessions, session.id),
                    Boolean(unviewedBySession[session.id]),
                  )),
                );

                return (
                  <div key={project.id} className="flex w-full shrink-0 flex-col items-center gap-0.5">
                    <Tooltip content={<CollapsedProjectTooltip project={project} sessionCount={projectSessions.length} />} side="right">
                      <button
                        type="button"
                        data-testid={`compact-repository-${project.id}`}
                        data-compact-rail-item
                        onClick={() => navigateToProject(project.id)}
                        aria-label={`Open main workspace for ${project.name}`}
                        className={`${COMPACT_RAIL_BUTTON} text-xs font-semibold ${isActiveProject ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
                      >
                        {initial}
                        {projectAgentState === 'unknown'
                          ? <AgentActivityDot active={false} size="sm" className="absolute bottom-0 right-0" />
                          : <AgentStatusDot status={projectAgentState} size="sm" className="absolute bottom-0 right-0" />}
                      </button>
                    </Tooltip>

                    {expandedProjects.has(project.id) && projectSessions.map((session) => (
                      <Tooltip
                        key={session.id}
                        content={<CompactSessionTooltip session={session} label={session.name || 'Untitled'} />}
                        side="right"
                        interactive
                      >
                        <button
                          type="button"
                          data-testid={`compact-repository-pane-${session.id}`}
                          data-compact-rail-item
                          onClick={() => openCompactSession(session.id, 'repositories')}
                          onContextMenu={(event) => openCompactSessionMenu(event, session)}
                          aria-label={`Open pane ${project.name}/${session.name || 'Untitled'}`}
                          className={`${COMPACT_RAIL_BUTTON} ${session.id === activeSessionId && activeView === 'sessions' ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
                        >
                          <SessionStatusBadge
                            sessionId={session.id}
                            unknownFallback={(
                              <SquareTerminal
                                data-testid={`compact-repository-pane-placeholder-${session.id}`}
                                aria-hidden="true"
                                className="h-4 w-4 text-text-tertiary"
                              />
                            )}
                          />
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                );
              })}

              {sidebarSectionExpansion.repositories && activeProject && (
                <Tooltip content={`New pane in ${activeProject.name}`} side="right">
                  <button
                    type="button"
                    data-compact-rail-item
                    onClick={() => setShowCreateDialog(true)}
                    aria-label={`New pane in ${activeProject.name}`}
                    className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE} hover:text-interactive`}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </Tooltip>
              )}
            </div>
          </nav>

          {/* Bottom actions */}
          <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border-primary py-2">
            <Tooltip content={remoteFooterTooltip} side="right" interactive delay={250}>
              <button
                type="button"
                data-compact-rail-item
                onClick={onRemoteSettingsClick}
                aria-label={remoteFooterStatus.ariaLabel}
                className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${remoteFooterStatus.dotClassName}`} />
              </button>
            </Tooltip>
            <Tooltip content={hotkeyDisplay('open-settings') ? <Kbd>{hotkeyDisplay('open-settings')}</Kbd> : undefined} side="right">
              <button
                type="button"
                data-compact-rail-item
                onClick={onSettingsClick}
                aria-label="Settings"
                className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
              >
                <SettingsIcon className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content={hotkeyDisplay('toggle-sidebar') ? <Kbd>{hotkeyDisplay('toggle-sidebar')}</Kbd> : undefined} side="right">
              <button
                type="button"
                data-compact-rail-item
                onClick={onToggleCollapse}
                aria-label="Expand sidebar"
                className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        {showCreateDialog && activeProject && (
          <CreateSessionDialog
            isOpen={showCreateDialog}
            onClose={() => setShowCreateDialog(false)}
            projectName={activeProject.name}
            projectId={activeProject.id}
          />
        )}

        <TerminalPopover
          visible={compactSessionMenu !== null}
          x={compactSessionMenu?.x ?? 0}
          y={compactSessionMenu?.y ?? 0}
          onClose={() => setCompactSessionMenu(null)}
        >
          <div role="menu" aria-label={`Pane actions for ${compactSessionMenu?.session.name || 'Untitled'}`}>
            <PopoverButton role="menuitem" onClick={() => void toggleCompactSessionPinned()}>
              <span className="flex items-center gap-2">
                <Pin className="h-4 w-4 rotate-45" />
                {compactSessionMenu?.session.isFavorite ? 'Unpin' : 'Pin'}
              </span>
            </PopoverButton>
            {/* Archive sits last, past the divider: the menu opens under the cursor,
                so the top slot is the one clicked by reflex. */}
            <div className="my-1 border-t border-border-primary" />
            <PopoverButton role="menuitem" variant="danger" onClick={() => void archiveCompactSession()}>
              <span className="flex items-center gap-2">
                <Archive className="h-4 w-4" />
                Archive
              </span>
            </PopoverButton>
          </div>
        </TerminalPopover>
      </>
    );
  }

  return (
    <>
      <div
        data-testid="sidebar"
        className="pane-sidebar-shell bg-surface-primary text-text-primary h-full flex flex-col relative flex-shrink-0"
        style={{ width: `${width}px` }}
      >
        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize group z-10"
          onMouseDown={onResize}
        >
          {/* Visual indicator */}
          <div className="absolute inset-0 group-hover:bg-interactive transition-colors" />
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
                  ref={resourceMenuButtonRef}
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
                  id: 'resources',
                  label: 'Resource Usage',
                  icon: Cpu,
                  onClick: openResourcePopover
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
          <ProjectSessionList
            projects={projects}
            onProjectsChange={setProjects}
            onProjectsRefresh={loadProjects}
            sessionSortAscending={sessionSortAscending}
            pinnedSectionExpanded={sidebarSectionExpansion.pinned}
            repositoriesSectionExpanded={sidebarSectionExpansion.repositories}
            onPinnedSectionExpandedChange={handlePinnedSectionExpandedChange}
            onRepositoriesSectionExpandedChange={handleRepositoriesSectionExpandedChange}
            showRemoteDesktopLink={showRemoteDesktopLink}
            onRemoteDesktopClick={handleOpenRemoteDesktop}
            remoteDesktopTooltip={REMOTE_DESKTOP_TOOLTIP}
          />
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
          <div className="px-3 py-2 border-t border-border-primary space-y-1.5">
            <div className="flex items-center justify-center gap-2">
              <Tooltip content={remoteFooterTooltip} side="top" interactive delay={250}>
                <button
                  type="button"
                  onClick={onRemoteSettingsClick}
                  aria-label={remoteFooterStatus.ariaLabel}
                  className="flex min-w-0 items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors truncate"
                >
                  <span className={`h-2 w-2 rounded-full flex-shrink-0 ${remoteFooterStatus.dotClassName}`} />
                  <span className="font-medium">Remote</span>
                </button>
              </Tooltip>
              <button
                type="button"
                onClick={onFeedbackClick}
                className="rounded-full border border-border-primary px-2 py-0.5 text-[11px] font-medium text-text-tertiary transition-colors hover:border-border-secondary hover:bg-surface-hover hover:text-text-secondary focus:outline-none focus:ring-2 focus:ring-interactive"
              >
                Feedback
              </button>
            </div>
            {version && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-text-tertiary truncate">
                <button
                  type="button"
                  className="hover:text-text-secondary transition-colors"
                  onClick={onAboutClick}
                  aria-label={`About Pane version ${version}`}
                >
                  v{version}{worktreeName && ` \u00b7 ${worktreeName}`}{gitCommit && ` \u00b7 ${gitCommit}`}
                </button>
                <span className="text-border-primary">&middot;</span>
                <button
                  type="button"
                  className="hover:text-text-secondary transition-colors"
                  onClick={onDocsClick}
                >
                  Docs
                </button>
              </div>
            )}
          </div>
        </div>
    </div>

      {showResourcePopover && createPortal(
        <div
          ref={resourcePopoverRef}
          role="dialog"
          aria-label="Resource Usage"
          aria-busy={resourceLoading}
          tabIndex={-1}
          className="bg-surface-primary border border-border-subtle/60 rounded-lg shadow-dropdown-elevated backdrop-blur-sm animate-dropdown-enter overflow-hidden w-[320px] max-w-[calc(100vw-16px)]"
          style={resourcePopoverStyle}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-secondary">
            <span className="text-[10px] font-semibold text-text-tertiary tracking-wider uppercase">
              Resource Usage
            </span>
            <button
              type="button"
              onClick={handleResourceRefresh}
              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
              disabled={resourceLoading}
              aria-label="Refresh resource usage"
            >
              <RefreshCw aria-hidden="true" className={`w-3.5 h-3.5 ${resourceLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {!snapshot ? (
            <div className="px-3 py-4 text-sm text-text-secondary">
              {resourceLoading ? 'Loading resource usage...' : 'No resource snapshot yet.'}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-4 px-3 py-2 border-b border-border-secondary">
                <span className="text-sm text-text-secondary">
                  CPU <strong className="text-text-primary">{snapshot.cpuReady ? `${snapshot.totalCpuPercent.toFixed(1)}%` : '-'}</strong>
                </span>
                <span className="text-sm text-text-secondary">
                  Memory <strong className="text-text-primary">{formatMemory(snapshot.totalMemoryMB)}</strong>
                </span>
              </div>

              <div className="max-h-[400px] overflow-y-auto">
                <div className="border-b border-border-secondary">
                  <button
                    type="button"
                    onClick={() => toggleResourceSection('pane-app')}
                    aria-expanded={expandedResourceSections.has('pane-app')}
                    aria-controls="resource-pane-app-processes"
                    className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-surface-hover transition-colors"
                  >
                    <div className="flex items-center gap-1.5">
                      {expandedResourceSections.has('pane-app')
                        ? <ChevronDown className="w-3 h-3 text-text-quaternary" />
                        : <ChevronRight className="w-3 h-3 text-text-quaternary" />}
                      <span className="text-sm font-medium text-text-primary">Pane App</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-text-tertiary font-mono">
                      <span>{snapshot.cpuReady ? `${electronTotalCpu.toFixed(1)}%` : '-'}</span>
                      <span>{formatMemory(electronTotalMem)}</span>
                    </div>
                  </button>
                  {expandedResourceSections.has('pane-app') && <div id="resource-pane-app-processes">{snapshot.electronProcesses.map(p => (
                    <div key={p.pid} className="flex items-center justify-between px-3 py-1 pl-8">
                      <span className="text-xs text-text-secondary">{p.label}</span>
                      <div className="flex items-center gap-3 text-xs text-text-tertiary font-mono">
                        <span>{snapshot.cpuReady ? `${p.cpuPercent.toFixed(1)}%` : '-'}</span>
                        <span>{formatMemory(p.memoryMB)}</span>
                      </div>
                    </div>
                  ))}</div>}
                </div>

                {snapshot.sessions.map(sess => (
                  <div key={sess.sessionId} className="border-b border-border-secondary">
                    <button
                      type="button"
                      onClick={() => toggleResourceSection(sess.sessionId)}
                      aria-expanded={expandedResourceSections.has(sess.sessionId)}
                      aria-controls={`resource-session-${sess.sessionId}`}
                      className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-surface-hover transition-colors"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {expandedResourceSections.has(sess.sessionId)
                          ? <ChevronDown className="w-3 h-3 text-text-quaternary flex-shrink-0" />
                          : <ChevronRight className="w-3 h-3 text-text-quaternary flex-shrink-0" />}
                        <span className="text-sm font-medium text-text-primary truncate">{sess.sessionName}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-tertiary font-mono flex-shrink-0 ml-2">
                        <span>{snapshot.cpuReady ? `${sess.totalCpuPercent.toFixed(1)}%` : '-'}</span>
                        <span>{formatMemory(sess.totalMemoryMB)}</span>
                      </div>
                    </button>
                    {expandedResourceSections.has(sess.sessionId) && <div id={`resource-session-${sess.sessionId}`}>{sess.children.map(child => (
                      <div key={child.pid} className="flex items-center justify-between px-3 py-1 pl-8">
                        <span className="text-xs text-text-secondary truncate">{child.name}</span>
                        <div className="flex items-center gap-3 text-xs text-text-tertiary font-mono flex-shrink-0 ml-2">
                          <span>{snapshot.cpuReady ? `${child.cpuPercent.toFixed(1)}%` : '-'}</span>
                          <span>{formatMemory(child.memoryMB)}</span>
                        </div>
                      </div>
                    ))}</div>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
