import { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronRight, Plus, FolderPlus, GitBranch, MoreHorizontal, Home, Archive, ArchiveRestore, Trash2, GitPullRequest, Pin, Monitor } from 'lucide-react';
import { SessionDetailTooltip } from './SessionDetailTooltip';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { CreateSessionDialog } from './CreateSessionDialog';
import { AddProjectDialog } from './AddProjectDialog';
import { Dropdown } from './ui/Dropdown';
import { Tooltip } from './ui/Tooltip';
import type { DropdownItem } from './ui/Dropdown';
import { API } from '../utils/api';
import { cn } from '../utils/cn';
import type { Session, GitStatus } from '../types/session';
import type { Project } from '../types/project';
import { usePanelStore } from '../stores/panelStore';
import type { SidebarNavigationScope } from '../stores/navigationStore';
import {
  createProjectById,
  flattenSessionsByProjects,
  getPinnedSessions,
  groupSessionsByProject,
} from '../utils/sessionOrdering';



interface ProjectSessionListProps {
  sessionSortAscending: boolean;
  showRemoteDesktopLink?: boolean;
  onRemoteDesktopClick?: () => void;
  remoteDesktopTooltip?: string;
}

export function ProjectSessionList({
  sessionSortAscending,
  showRemoteDesktopLink = false,
  onRemoteDesktopClick,
  remoteDesktopTooltip,
}: ProjectSessionListProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForProject, setCreateForProject] = useState<Project | null>(null);
  const [pinnedSectionExpanded, setPinnedSectionExpanded] = useState(true);
  const [repositoriesSectionExpanded, setRepositoriesSectionExpanded] = useState(true);

  // Add project dialog state
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);

  // Drag-to-reorder state
  const [dragProjectId, setDragProjectId] = useState<number | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<number | null>(null);

  const sessions = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const navigateToSessions = useNavigationStore(s => s.navigateToSessions);
  const navigateToProject = useNavigationStore(s => s.navigateToProject);
  const setSidebarNavigationScope = useNavigationStore(s => s.setSidebarNavigationScope);
  // Expansion state lives in the navigation store so the always-mounted
  // session hotkeys (useSessionNavigationHotkeys) see the same visible ordering
  const expandedProjects = useNavigationStore(s => s.expandedProjects);
  const toggleProjectExpanded = useNavigationStore(s => s.toggleProjectExpanded);
  const expandProject = useNavigationStore(s => s.expandProject);
  const panelPanels = usePanelStore(s => s.panels);
  const panelActivityStatus = usePanelStore(s => s.activityStatus);

  // Load projects
  const loadProjects = useCallback(async () => {
    try {
      const res = await API.projects.getAll();
      if (res.success && res.data) {
        setProjects(res.data);
      }
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
  }, []);

  useEffect(() => {
    loadProjects();
    const handle = () => loadProjects();
    window.addEventListener('project-changed', handle);
    window.addEventListener('project-sessions-refresh', handle);
    return () => {
      window.removeEventListener('project-changed', handle);
      window.removeEventListener('project-sessions-refresh', handle);
    };
  }, [loadProjects]);

  // Group sessions by project
  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sessions, sessionSortAscending),
    [sessions, sessionSortAscending]
  );

  const projectById = useMemo(() => createProjectById(projects), [projects]);

  const pinnedSessions = useMemo(() => {
    return getPinnedSessions(sessions, projectById);
  }, [sessions, projectById]);

  // mod+1-9 session switch hotkeys are registered in useSessionNavigationHotkeys
  // (always mounted in Sidebar), and new-project auto-expansion lives there too.

  // Auto-expand the project that contains the active session
  // (e.g., when a new session is created and auto-activated)
  useEffect(() => {
    if (!activeSessionId) return;
    const currentSessions = useSessionStore.getState().sessions;
    const session = currentSessions.find(s => s.id === activeSessionId);
    if (!session?.projectId) return;
    expandProject(session.projectId);
  }, [activeSessionId, expandProject]);

  const toggleProject = (id: number) => {
    toggleProjectExpanded(id);
  };

  const handleSessionClick = (sessionId: string, scope: SidebarNavigationScope = 'repositories') => {
    setSidebarNavigationScope(scope);
    setActiveSession(sessionId);
    navigateToSessions();
  };

  const handleNewSession = (project: Project) => {
    setCreateForProject(project);
    setShowCreateDialog(true);
  };

  // Session operations
  const handleArchiveSession = async (sessionId: string) => {
    try {
      await API.sessions.delete(sessionId);
    } catch (e) {
      console.error('Failed to archive session:', e);
    }
  };

  const handleTogglePinnedSession = async (sessionId: string) => {
    try {
      await API.sessions.toggleFavorite(sessionId);
    } catch (e) {
      console.error('Failed to toggle pinned session:', e);
    }
  };

  // Project operations
  const handleDeleteProject = async (projectId: number) => {
    try {
      await API.projects.delete(String(projectId));
      loadProjects();
      window.dispatchEvent(new Event('project-changed'));
    } catch (e) {
      console.error('Failed to delete project:', e);
    }
  };

  // Drag-to-reorder handlers
  const handleProjectDragStart = (e: React.DragEvent, projectId: number) => {
    setDragProjectId(projectId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(projectId));
  };

  const handleProjectDragOver = (e: React.DragEvent, projectId: number) => {
    e.preventDefault();
    if (dragProjectId !== null && dragProjectId !== projectId) {
      setDragOverProjectId(projectId);
    }
  };

  const handleProjectDrop = async (e: React.DragEvent, targetProjectId: number) => {
    e.preventDefault();
    if (dragProjectId === null || dragProjectId === targetProjectId) {
      setDragProjectId(null);
      setDragOverProjectId(null);
      return;
    }

    let payload: Array<{ id: number; displayOrder: number }> = [];
    setProjects(current => {
      const newProjects = [...current];
      const fromIndex = newProjects.findIndex(p => p.id === dragProjectId);
      const toIndex = newProjects.findIndex(p => p.id === targetProjectId);
      if (fromIndex === -1 || toIndex === -1) return current;

      const [moved] = newProjects.splice(fromIndex, 1);
      newProjects.splice(toIndex, 0, moved);

      payload = newProjects.map((p, i) => ({ id: p.id, displayOrder: i }));
      return newProjects;
    });

    setDragProjectId(null);
    setDragOverProjectId(null);

    if (payload.length > 0) {
      try {
        await API.projects.reorder(payload);
        window.dispatchEvent(new Event('project-changed'));
      } catch (err) {
        console.error('Failed to reorder projects:', err);
        loadProjects();
      }
    }
  };

  const handleProjectDragEnd = () => {
    setDragProjectId(null);
    setDragOverProjectId(null);
  };

  // Compute global index for each session (for hotkey labels in tooltips)
  const globalSessionIndex = useMemo(() => {
    const map = new Map<string, number>();
    flattenSessionsByProjects(projects, sessionsByProject, expandedProjects).forEach((session, index) => {
      map.set(session.id, index);
    });
    return map;
  }, [projects, expandedProjects, sessionsByProject]);

  return (
    <>
      <div className="flex flex-col py-1">
        {/* Home */}
        <button
          onClick={() => {
            setSidebarNavigationScope('repositories');
            setActiveSession(null);
            navigateToSessions();
          }}
          className="flex items-center gap-2.5 px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
        >
          <Home className="w-4 h-4" />
          <span>Home</span>
        </button>

        {showRemoteDesktopLink && onRemoteDesktopClick && (
          <Tooltip content={remoteDesktopTooltip} side="right" className="block w-full">
            <button
              type="button"
              onClick={onRemoteDesktopClick}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
            >
              <Monitor className="w-4 h-4" />
              <span>Remote Desktop</span>
            </button>
          </Tooltip>
        )}

        {pinnedSessions.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setPinnedSectionExpanded(expanded => !expanded)}
              className="group/section mt-2 flex w-full items-center gap-1.5 px-3 pt-1 pb-1 text-left text-sm text-text-tertiary hover:text-text-primary focus-visible:text-text-primary transition-colors"
            >
              <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-visible/section:opacity-100">
                {pinnedSectionExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-current" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-current" />
                )}
              </span>
              <span className="text-sm text-text-tertiary truncate">Pinned</span>
            </button>
            {pinnedSectionExpanded && (
              <div className="mt-0.5">
                {pinnedSessions.map(({ session, label }) => (
                  <SessionRow
                    key={`pinned-${session.id}`}
                    session={session}
                    isActive={session.id === activeSessionId}
                    globalIndex={-1}
                    displayName={label}
                    onClick={() => handleSessionClick(session.id, 'pinned')}
                    onArchive={() => handleArchiveSession(session.id)}
                    onTogglePinned={() => handleTogglePinnedSession(session.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-2 px-3 pt-1 pb-1 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setRepositoriesSectionExpanded(expanded => !expanded)}
            className="group/section flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm text-text-tertiary hover:text-text-primary focus-visible:text-text-primary transition-colors"
          >
            <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-visible/section:opacity-100">
              {repositoriesSectionExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-current" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-current" />
              )}
            </span>
            <span className="text-sm text-text-tertiary truncate">Repositories</span>
          </button>
          <button
            onClick={() => setShowAddProjectDialog(true)}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
            title="New repository"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Projects */}
        {repositoriesSectionExpanded && projects.map(project => {
          const isExpanded = expandedProjects.has(project.id);
          const projectSessions = sessionsByProject.get(project.id) || [];

          const projectActivity = projectSessions.some(s => {
            const sessionPanels = panelPanels[s.id] || [];
            return sessionPanels.some(p => panelActivityStatus[p.id] === 'active');
          }) ? 'active' : 'idle';

          const projectMenuItems: DropdownItem[] = [
            {
              id: 'main-workspace',
              label: 'Open session on main',
              icon: GitBranch,
              onClick: () => navigateToProject(project.id),
            },
            {
              id: 'delete',
              label: 'Delete Project',
              icon: Trash2,
              variant: 'danger',
              onClick: () => {
                if (confirm(`Delete project "${project.name}"? Panes will be archived.`)) {
                  handleDeleteProject(project.id);
                }
              },
            },
          ];

          return (
            <div key={project.id} className="mt-3 first:mt-2">
              {/* Project header */}
              <div
                className={cn(
                  "group/project flex items-center px-4 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer",
                  dragOverProjectId === project.id && dragProjectId !== project.id && "bg-interactive/20",
                  dragProjectId === project.id && "opacity-50"
                )}
                onClick={() => toggleProject(project.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleProject(project.id);
                  }
                }}
                draggable
                onDragStart={(e) => handleProjectDragStart(e, project.id)}
                onDragOver={(e) => handleProjectDragOver(e, project.id)}
                onDrop={(e) => handleProjectDrop(e, project.id)}
                onDragEnd={handleProjectDragEnd}
                onDragLeave={() => setDragOverProjectId(null)}
              >
                <Tooltip content={<span className="text-[10px] text-text-tertiary font-mono break-all">{project.path}</span>} side="right">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={cn(
                        "w-1.5 h-1.5 rounded-full flex-shrink-0 transition-all",
                        projectActivity === 'active'
                          ? 'bg-status-info opacity-100 duration-150'
                          : 'bg-text-muted/20 opacity-40 duration-[3s]'
                      )} />
                      <span className="text-xs font-semibold text-text-primary truncate">{project.name}</span>
                    </div>
                  </div>
                </Tooltip>
                <div
                  className="flex-shrink-0 opacity-0 group-hover/project:opacity-100 transition-opacity ml-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Dropdown
                    trigger={
                      <button
                        className="p-1 rounded text-text-muted hover:text-text-tertiary hover:bg-surface-hover transition-colors"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    }
                    items={projectMenuItems}
                    position="auto"
                    width="sm"
                  />
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNewSession(project);
                  }}
                  className="flex-shrink-0 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
                  title="New workspace"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              {isExpanded && projectSessions.length > 0 && (
                <div className="mt-0.5">
                  {projectSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      globalIndex={globalSessionIndex.get(session.id) ?? -1}
                      onClick={() => handleSessionClick(session.id, 'repositories')}
                      onArchive={() => handleArchiveSession(session.id)}
                      onTogglePinned={() => handleTogglePinnedSession(session.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Create Session Dialog */}
      {showCreateDialog && createForProject && (
        <CreateSessionDialog
          isOpen={showCreateDialog}
          onClose={() => {
            setShowCreateDialog(false);
            setCreateForProject(null);
          }}
          projectName={createForProject.name}
          projectId={createForProject.id}
        />
      )}

      {/* Add Project Dialog */}
      <AddProjectDialog
        isOpen={showAddProjectDialog}
        onClose={() => setShowAddProjectDialog(false)}
      />
    </>
  );
}



// --- Session row button content ---

function SessionRowContent({
  session,
  gs,
  iconColor,
  hasDiff,
  adds,
  dels,
  displayName,
  showActivity,
  showUnviewedCompleted,
}: {
  session: Session;
  gs: GitStatus | undefined;
  iconColor: string;
  hasDiff: boolean;
  adds: number;
  dels: number;
  displayName?: string;
  showActivity: boolean;
  showUnviewedCompleted: boolean;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0 w-full">
      {gs?.prNumber ? (
        <GitPullRequest className={`w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />
      ) : (
        <GitBranch className={`w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />
      )}
      <span className={cn(
        'text-sm font-medium text-text-primary truncate flex-1 min-w-0 decoration-status-info decoration-2 underline-offset-4',
        showActivity && 'animate-sidebar-active-label',
        showUnviewedCompleted && 'underline decoration-dashed'
      )}>
        {displayName || gs?.prTitle || session.name || 'Untitled'}
      </span>
      {gs?.prNumber ? (
        <span className="text-xs text-text-tertiary flex-shrink-0">#{gs.prNumber}</span>
      ) : hasDiff ? (
        <span className="flex items-center gap-1 text-xs flex-shrink-0">
          <span className="text-status-success font-semibold">+{adds}</span>
          <span className="text-status-error font-semibold">-{dels}</span>
        </span>
      ) : null}
    </div>
  );
}

// --- Session row sub-component ---

interface SessionRowProps {
  session: Session;
  isActive: boolean;
  globalIndex: number;
  onClick: () => void;
  onArchive: () => void;
  onTogglePinned: () => void;
  displayName?: string;
}

interface GitStatusIPCResponse {
  success: boolean;
  gitStatus?: GitStatus;
}

function SessionRow({
  session, isActive, globalIndex, onClick,
  onArchive, onTogglePinned, displayName,
}: SessionRowProps) {
  const [localGitStatus, setLocalGitStatus] = useState<GitStatus | undefined>(session.gitStatus);

  const sessionActivity = usePanelStore(s => {
    const sessionPanels = s.panels[session.id] || [];
    return sessionPanels.some(p => s.activityStatus[p.id] === 'active') ? 'active' : 'idle';
  });
  const hasUnviewedCompletedActivity = usePanelStore(s => Boolean(s.unviewedCompletedActivity[session.id]));

  // Fetch git status if not available
  useEffect(() => {
    if (localGitStatus || session.gitStatus || session.archived || session.status === 'error') return;
    const fetchStatus = async () => {
      try {
        if (!window.electron?.invoke) return;
        const res = await window.electron.invoke(
          'sessions:get-git-status',
          session.id,
          false,
          true
        ) as GitStatusIPCResponse;
        if (res?.success && res.gitStatus) {
          setLocalGitStatus(res.gitStatus);
        }
      } catch {
        // Silently fail
      }
    };
    fetchStatus();
  }, [session.id, session.archived, session.status, localGitStatus, session.gitStatus]);

  // Sync from session prop when store updates
  useEffect(() => {
    if (session.gitStatus) setLocalGitStatus(session.gitStatus);
  }, [session.gitStatus]);

  // Listen for background git status updates (e.g., PR enrichment)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string; gitStatus: GitStatus }>).detail;
      if (detail?.sessionId === session.id && detail?.gitStatus) {
        setLocalGitStatus(detail.gitStatus);
      }
    };
    window.addEventListener('git-status-updated', handler);
    return () => window.removeEventListener('git-status-updated', handler);
  }, [session.id]);

  const gs = localGitStatus;

  const iconColor = gs?.prState
    ? gs.prState === 'MERGED' ? 'text-purple-400'
    : gs.prState === 'CLOSED' ? 'text-red-400'
    : 'text-green-400'
    : session.status === 'running' || session.status === 'initializing'
    ? 'text-status-success'
    : session.status === 'error'
    ? 'text-status-error'
    : 'text-text-tertiary';

  const adds = (gs?.commitAdditions ?? 0) + (gs?.additions ?? 0);
  const dels = (gs?.commitDeletions ?? 0) + (gs?.deletions ?? 0);
  const hasDiff = adds > 0 || dels > 0;
  const showActivity = sessionActivity === 'active';

  return (
    <Tooltip
      content={<SessionDetailTooltip session={session} gitStatus={localGitStatus} showName={false} showDiffStats={false} globalIndex={globalIndex} />}
      side="right"
      className="block w-full"
      interactive
    >
      <div
        className={`group/session relative w-full text-left pl-3 pr-3 py-1.5 transition-colors flex items-center gap-1 cursor-pointer ${
          isActive
            ? 'bg-interactive/30 border-l-4 border-interactive'
            : 'hover:bg-surface-hover border-l-4 border-transparent'
        }`}
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <SessionRowContent
          session={session}
          gs={gs}
          iconColor={iconColor}
          hasDiff={hasDiff}
          adds={adds}
          dels={dels}
          displayName={displayName}
          showActivity={showActivity}
          showUnviewedCompleted={hasUnviewedCompletedActivity && !isActive && !showActivity}
        />

        <div className="flex flex-shrink-0 items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onTogglePinned(); }}
            className={`inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-all ${
              session.isFavorite
                ? 'text-text-muted hover:text-text-tertiary hover:bg-surface-hover opacity-100'
                : 'text-text-muted hover:text-text-tertiary hover:bg-surface-hover opacity-0 group-hover/session:opacity-100'
            }`}
            title={session.isFavorite ? 'Unpin' : 'Pin'}
            aria-label={session.isFavorite ? 'Unpin pane' : 'Pin pane'}
          >
            <Pin className="w-3.5 h-3.5 rotate-45" />
          </button>

          {/* Archive button - on hover */}
          <button
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-muted hover:text-status-error hover:bg-surface-hover transition-all opacity-0 group-hover/session:opacity-100"
            title="Archive"
          >
            <Archive className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </Tooltip>
  );
}

// --- Archived Sessions panel (pinned to sidebar bottom) ---

export function ArchivedSessions() {
  const [showArchived, setShowArchived] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<Array<Project & { sessions: Session[] }>>([]);
  const [expandedArchivedProjects, setExpandedArchivedProjects] = useState<Set<number>>(new Set());
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);
  const [hasLoadedArchived, setHasLoadedArchived] = useState(false);

  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const navigateToSessions = useNavigationStore(s => s.navigateToSessions);

  const loadArchivedSessions = useCallback(async () => {
    try {
      setIsLoadingArchived(true);
      const response = await API.sessions.getArchivedWithProjects();
      if (response.success && response.data) {
        setArchivedProjects(response.data as Array<Project & { sessions: Session[] }>);
      }
    } catch (e) {
      console.error('Failed to load archived sessions:', e);
    } finally {
      setIsLoadingArchived(false);
      setHasLoadedArchived(true);
    }
  }, []);

  const toggleArchived = useCallback(() => {
    setShowArchived(prev => {
      const next = !prev;
      if (next && !hasLoadedArchived) {
        loadArchivedSessions();
      }
      return next;
    });
  }, [hasLoadedArchived, loadArchivedSessions]);

  const toggleArchivedProject = (id: number) => {
    setExpandedArchivedProjects(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRestoreSession = async (sessionId: string) => {
    try {
      await API.sessions.restore(sessionId);
      loadArchivedSessions();
    } catch (e) {
      console.error('Failed to restore session:', e);
    }
  };

  const handleSessionClick = (sessionId: string) => {
    setActiveSession(sessionId);
    navigateToSessions();
  };

  return (
    <div className="border-t border-border-primary">
      <button
        onClick={toggleArchived}
        className="w-full flex items-center gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
      >
        {showArchived ? (
          <ChevronDown className="w-3 h-3 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
        )}
        <Archive className="w-3 h-3 flex-shrink-0" />
        <span>Archived</span>
        {hasLoadedArchived && archivedProjects.length > 0 && (
          <span className="ml-auto text-[10px] text-text-muted font-normal tabular-nums">
            {archivedProjects.reduce((sum, p) => sum + p.sessions.length, 0)}
          </span>
        )}
      </button>

      {showArchived && (
        <div className="pb-2 max-h-[40vh] overflow-y-auto">
          {isLoadingArchived ? (
            <div className="px-4 py-2 space-y-2 animate-pulse">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-7 bg-surface-tertiary rounded" />
              ))}
            </div>
          ) : archivedProjects.length === 0 ? (
            <div className="px-6 py-3 text-xs text-text-tertiary">
              No archived panes
            </div>
          ) : (
            archivedProjects.map(project => {
              const isExpanded = expandedArchivedProjects.has(project.id);
              return (
                <div key={`archived-${project.id}`}>
                  <button
                    onClick={() => toggleArchivedProject(project.id)}
                    className="w-full flex items-center gap-2 px-6 py-1.5 text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3 h-3 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-3 h-3 flex-shrink-0" />
                    )}
                    <span className="truncate">{project.name}</span>
                    <span className="ml-auto text-text-muted text-[10px]">{project.sessions.length}</span>
                  </button>
                  {isExpanded && project.sessions.map(session => (
                    <div
                      key={session.id}
                      className="group/archived flex items-center gap-1 pl-10 pr-1 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer"
                      onClick={() => handleSessionClick(session.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSessionClick(session.id);
                        }
                      }}
                    >
                      <div className="flex-1 text-left min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <Archive className="w-3 h-3 flex-shrink-0 text-text-muted" />
                          <span className="text-xs text-text-tertiary truncate">
                            {session.name || 'Untitled'}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRestoreSession(session.id); }}
                        className="flex-shrink-0 p-1 rounded text-text-muted hover:text-status-success hover:bg-surface-hover transition-all opacity-0 group-hover/archived:opacity-100"
                        title="Restore"
                      >
                        <ArchiveRestore className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
