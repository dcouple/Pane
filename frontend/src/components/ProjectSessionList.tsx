import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ChevronDown, ChevronRight, Plus, FolderPlus, GitBranch, GitFork, MoreHorizontal, Home, Archive, ArchiveRestore, Trash2, GitPullRequest } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { CreateSessionDialog } from './CreateSessionDialog';
import { AddProjectDialog } from './AddProjectDialog';
import { Dropdown } from './ui/Dropdown';
import { Tooltip } from './ui/Tooltip';
import type { DropdownItem } from './ui/Dropdown';
import { API } from '../utils/api';
import { cycleIndex } from '../utils/arrayUtils';
import type { Session, GitStatus } from '../types/session';
import type { Project } from '../types/project';



interface ProjectSessionListProps {
  sessionSortAscending: boolean;
}

export function ProjectSessionList({ sessionSortAscending }: ProjectSessionListProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set());
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForProject, setCreateForProject] = useState<Project | null>(null);

  // Add project dialog state
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);

  const sessions = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const navigateToSessions = useNavigationStore(s => s.navigateToSessions);
  const navigateToProject = useNavigationStore(s => s.navigateToProject);

  // Hotkey registration
  const register = useHotkeyStore(s => s.register);
  const unregister = useHotkeyStore(s => s.unregister);

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
  const sessionsByProject = useMemo(() => {
    const map = new Map<number, Session[]>();
    sessions
      .filter(s => !s.archived)
      .forEach(s => {
        if (s.projectId != null) {
          const list = map.get(s.projectId) || [];
          list.push(s);
          map.set(s.projectId, list);
        }
      });
    map.forEach((list, key) => {
      map.set(key, list.sort((a, b) => {
        const da = new Date(a.createdAt).getTime();
        const db = new Date(b.createdAt).getTime();
        return sessionSortAscending ? da - db : db - da;
      }));
    });
    return map;
  }, [sessions, sessionSortAscending]);

  // Flat list of all visible sessions (for hotkey mapping)
  const allVisibleSessions = useMemo(() => {
    const result: Session[] = [];
    projects.forEach(p => {
      if (expandedProjects.has(p.id)) {
        const list = sessionsByProject.get(p.id) || [];
        result.push(...list);
      }
    });
    return result;
  }, [projects, expandedProjects, sessionsByProject]);

  // Flat list of ALL active sessions (for cycling - includes collapsed projects)
  const allActiveSessions = useMemo(() => {
    const result: Session[] = [];
    projects.forEach(p => {
      const list = sessionsByProject.get(p.id) || [];
      result.push(...list);
    });
    return result;
  }, [projects, sessionsByProject]);

  // Register ⌘1-⌘9 hotkeys with dynamic session name labels
  const allVisibleSessionsRef = useRef(allVisibleSessions);
  allVisibleSessionsRef.current = allVisibleSessions;
  const allActiveSessionsRef = useRef(allActiveSessions);
  allActiveSessionsRef.current = allActiveSessions;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const setActiveSessionRef = useRef(setActiveSession);
  setActiveSessionRef.current = setActiveSession;
  const navigateToSessionsRef = useRef(navigateToSessions);
  navigateToSessionsRef.current = navigateToSessions;
  const expandedProjectsRef = useRef(expandedProjects);
  expandedProjectsRef.current = expandedProjects;
  const setExpandedProjectsRef = useRef(setExpandedProjects);
  setExpandedProjectsRef.current = setExpandedProjects;

  // Build stable label key so we re-register when session names/projects change
  const sessionLabelKey = allVisibleSessions.slice(0, 9).map(s => `${s.name}:${s.projectId}`).join('|');
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    const ids: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const id = `switch-session-${i}`;
      ids.push(id);
      const session = allVisibleSessionsRef.current[i - 1];
      let label = `Switch to pane ${i}`;
      if (session) {
        const project = projectsRef.current.find(p => p.id === session.projectId);
        label = project
          ? `Switch to ${session.name} (${project.name})`
          : `Switch to ${session.name}`;
      }
      const idx = i - 1;
      register({
        id,
        label,
        keys: `mod+${i}`,
        category: 'session',
        enabled: () => !!allVisibleSessionsRef.current[idx],
        action: () => {
          const s = allVisibleSessionsRef.current[idx];
          if (s) {
            setActiveSessionRef.current(s.id);
            navigateToSessionsRef.current();
          }
        },
      });
    }
    return () => ids.forEach(id => unregister(id));
  }, [register, unregister, sessionLabelKey]);

  // Session cycling: navigates to next/prev session across ALL active sessions
  // (not just visible ones from expanded projects). Auto-expands collapsed
  // projects when cycling to their sessions so users can see the selection.
  const cycleSession = useCallback((direction: 'next' | 'prev') => {
    const sessions = allActiveSessionsRef.current;
    if (sessions.length === 0) return;

    const currentId = activeSessionIdRef.current;
    const currentIndex = sessions.findIndex(s => s.id === currentId);
    const nextIndex = cycleIndex(currentIndex, sessions.length, direction);
    if (nextIndex === -1) return;

    const nextSession = sessions[nextIndex];

    // Auto-expand the project if it's collapsed
    if (nextSession.projectId != null && !expandedProjectsRef.current.has(nextSession.projectId)) {
      setExpandedProjectsRef.current(prev => {
        const next = new Set(prev);
        next.add(nextSession.projectId!);
        return next;
      });
    }

    setActiveSessionRef.current(nextSession.id);
    navigateToSessionsRef.current();
  }, []);

  // Register session cycling hotkeys
  useEffect(() => {
    const nextKeys = ['mod+shift+Tab', 'mod+ArrowDown'];
    const prevKeys = ['mod+Tab', 'mod+ArrowUp'];
    const ids: string[] = [];

    nextKeys.forEach((keys, i) => {
      const id = `cycle-session-next-${i}`;
      ids.push(id);
      register({
        id,
        label: 'Next Pane',
        keys,
        category: 'session',
        enabled: () => allActiveSessionsRef.current.length > 1,
        action: () => cycleSession('next'),
      });
    });

    prevKeys.forEach((keys, i) => {
      const id = `cycle-session-prev-${i}`;
      ids.push(id);
      register({
        id,
        label: 'Previous Pane',
        keys,
        category: 'session',
        enabled: () => allActiveSessionsRef.current.length > 1,
        action: () => cycleSession('prev'),
      });
    });

    return () => ids.forEach(id => unregister(id));
  }, [register, unregister, cycleSession]);

  // Track known project IDs so we only auto-expand newly added ones
  const knownProjectIds = useRef<Set<number>>(new Set());
  const projectIds = useMemo(() => projects.map(p => p.id).join(','), [projects]);

  // Auto-expand newly added projects (preserves user-collapsed state for existing ones)
  useEffect(() => {
    const newIds = projects.filter(p => !knownProjectIds.current.has(p.id)).map(p => p.id);
    knownProjectIds.current = new Set(projects.map(p => p.id));
    if (newIds.length > 0) {
      setExpandedProjects(prev => {
        const next = new Set(prev);
        newIds.forEach(id => next.add(id));
        return next;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIds]);

  const toggleProject = (id: number) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSessionClick = (sessionId: string) => {
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

  // Compute global index for each session (for hotkey labels)
  const globalSessionIndex = useMemo(() => {
    const map = new Map<string, number>();
    let idx = 0;
    projects.forEach(p => {
      if (expandedProjects.has(p.id)) {
        const list = sessionsByProject.get(p.id) || [];
        list.forEach(s => {
          map.set(s.id, idx);
          idx++;
        });
      }
    });
    return map;
  }, [projects, expandedProjects, sessionsByProject]);

  return (
    <>
      <div className="flex flex-col py-1">
        {/* Home */}
        <button
          onClick={() => {
            setActiveSession(null);
            navigateToSessions();
          }}
          className="flex items-center gap-2.5 px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
        >
          <Home className="w-4 h-4" />
          <span>Home</span>
        </button>

        <div className="mt-2 px-3 pt-1 pb-1 flex items-center justify-between gap-2">
          <span className="text-sm text-text-tertiary truncate">Repositories</span>
          <button
            onClick={() => setShowAddProjectDialog(true)}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
            title="New repository"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Projects */}
        {projects.map(project => {
          const isExpanded = expandedProjects.has(project.id);
          const projectSessions = sessionsByProject.get(project.id) || [];

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

          const pathParts = project.path.replace(/\\/g, '/').split('/').filter(Boolean);
          const repoName = pathParts[pathParts.length - 1] || project.name;
          const parentFolder = pathParts[pathParts.length - 2] || '';

          return (
            <div key={project.id} className="mt-3 first:mt-2">
              {/* Project header */}
              <div
                className="group/project flex items-center px-4 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer"
                onClick={() => toggleProject(project.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleProject(project.id);
                  }
                }}
              >
                <div className="flex-1 min-w-0 flex items-center gap-1.5">
                  <GitFork className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
                  {parentFolder && (
                    <span className="text-[10px] text-text-tertiary truncate">{parentFolder} /</span>
                  )}
                  <span className="text-xs font-semibold text-text-primary truncate">{repoName}</span>
                </div>
                <div className="flex-shrink-0 opacity-0 group-hover/project:opacity-100 transition-opacity ml-auto">
                  <Dropdown
                    trigger={
                      <button
                        className="p-1 rounded text-text-muted hover:text-text-tertiary hover:bg-surface-hover transition-colors"
                        onClick={(e) => e.stopPropagation()}
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

              {isExpanded && (
                <div className="mt-0.5">
                  {projectSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      globalIndex={globalSessionIndex.get(session.id) ?? -1}
                      onClick={() => handleSessionClick(session.id)}
                      onArchive={() => handleArchiveSession(session.id)}
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



function SessionTooltipContent({ gs }: {
  gs: GitStatus;
}) {
  return (
    <div className="max-w-xs space-y-1 text-[10px]">
      <div className="flex items-center gap-1.5">
        <GitPullRequest className={`w-3 h-3 flex-shrink-0 ${
          gs.prState === 'MERGED' ? 'text-purple-400' :
          gs.prState === 'CLOSED' ? 'text-red-400' :
          'text-green-400'
        }`} />
        <span className="font-medium text-text-primary">
          #{gs.prNumber} {gs.prState ? gs.prState.charAt(0) + gs.prState.slice(1).toLowerCase() : ''}
        </span>
      </div>
      {gs.prBody && (
        <div className="text-text-tertiary break-words leading-snug line-clamp-[32] prose prose-xs prose-invert max-w-none [&_h1]:text-[11px] [&_h2]:text-[11px] [&_h3]:text-[10px] [&_p]:text-[10px] [&_li]:text-[10px] [&_code]:text-[9px] [&_ul]:my-0.5 [&_ol]:my-0.5 [&_p]:my-0.5">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{gs.prBody}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// --- Session row button content (shared between tooltip and non-tooltip paths) ---

function SessionRowContent({ session, gs, iconColor, hasDiff, adds, dels, branch, statusText, statusColor, globalIndex }: {
  session: Session;
  gs: GitStatus | undefined;
  iconColor: string;
  hasDiff: boolean;
  adds: number;
  dels: number;
  branch: string;
  statusText: string;
  statusColor: string;
  globalIndex: number;
}) {
  return (
    <div className="w-full min-w-0">
      {/* Row 1: icon + name + diff stats */}
      <div className="flex items-center gap-2 min-w-0">
        {gs?.prNumber ? (
          <GitPullRequest className={`w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />
        ) : (
          <GitBranch className={`w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />
        )}
        <span className="text-sm font-medium text-text-primary truncate flex-1 min-w-0">
          {gs?.prTitle || session.name || 'Untitled'}
        </span>
        {hasDiff && (
          <span className="flex items-center gap-1 text-xs flex-shrink-0">
            <span className="text-status-success font-semibold">+{adds}</span>
            <span className="text-status-error font-semibold">-{dels}</span>
          </span>
        )}
      </div>
      {/* Row 2: branch · PR# · status + shortcut */}
      <div className="flex items-center gap-1 mt-0.5 pl-[22px] text-[11px] text-text-tertiary min-w-0">
        {branch && <span className="truncate flex-shrink min-w-0">{branch}</span>}
        {branch && (gs?.prNumber || statusText) && <span className="flex-shrink-0">·</span>}
        {gs?.prNumber && (
          <span className={`flex-shrink-0 ${
            gs.prState === 'MERGED' ? 'text-purple-400' :
            gs.prState === 'CLOSED' ? 'text-red-400' :
            'text-green-400'
          }`}>
            #{gs.prNumber} {gs.prState ? gs.prState.charAt(0) + gs.prState.slice(1).toLowerCase() : ''}
          </span>
        )}
        {gs?.prNumber && statusText && <span className="flex-shrink-0">·</span>}
        {statusText && (
          <span className={`truncate flex-shrink min-w-0 ${statusColor}`}>{statusText}</span>
        )}
        {globalIndex >= 0 && globalIndex < 9 && (
          <span className="ml-auto flex-shrink-0 text-text-muted text-[10px] opacity-0 group-hover/session:opacity-100 transition-opacity">⌘{globalIndex + 1}</span>
        )}
      </div>
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
}

interface GitStatusIPCResponse {
  success: boolean;
  gitStatus?: GitStatus;
}

function SessionRow({
  session, isActive, globalIndex, onClick,
  onArchive,
}: SessionRowProps) {
  const [localGitStatus, setLocalGitStatus] = useState<GitStatus | undefined>(session.gitStatus);

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
  const fullBranch = session.worktreePath?.replace(/\\/g, '/').split('/').pop() || '';
  const branch = fullBranch.length > 20 ? fullBranch.slice(0, 20) + '...' : fullBranch;

  // Status text + color
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
    if (gs.state === 'conflict') {
      statusText = 'Merge conflicts';
      statusColor = 'text-status-error';
    } else if (gs.isReadyToMerge) {
      statusText = 'Ready to merge';
      statusColor = 'text-status-success';
    } else if (gs.state === 'diverged') {
      statusText = 'Diverged';
      statusColor = 'text-status-warning';
    } else if (gs.state === 'ahead' && gs.ahead) {
      statusText = `${gs.ahead} ahead`;
      statusColor = 'text-status-warning';
    } else if (gs.state === 'behind' && gs.behind) {
      statusText = `${gs.behind} behind`;
    } else if (gs.state === 'clean') {
      statusText = 'Up to date';
    }
  }

  const iconColor = gs?.prState
    ? gs.prState === 'MERGED' ? 'text-purple-400'
    : gs.prState === 'CLOSED' ? 'text-red-400'
    : 'text-green-400'
    : session.status === 'running' || session.status === 'initializing'
    ? 'text-status-success'
    : session.status === 'waiting'
    ? 'text-status-warning'
    : session.status === 'error'
    ? 'text-status-error'
    : 'text-text-tertiary';

  const adds = (gs?.commitAdditions ?? 0) + (gs?.additions ?? 0);
  const dels = (gs?.commitDeletions ?? 0) + (gs?.deletions ?? 0);
  const hasDiff = adds > 0 || dels > 0;

  return (
    <div
      className={`group/session w-full text-left pl-6 pr-1 py-1.5 transition-colors flex items-center gap-1 cursor-pointer ${
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
      {/* Clickable session content */}
      {gs?.prNumber ? (
        <Tooltip
          content={<SessionTooltipContent gs={gs} />}
          side="right"
          className="block flex-1 min-w-0"
        >
          <SessionRowContent
            session={session}
            gs={gs}
            iconColor={iconColor}
            hasDiff={hasDiff}
            adds={adds}
            dels={dels}
            branch={branch}
            statusText={statusText}
            statusColor={statusColor}
            globalIndex={globalIndex}
          />
        </Tooltip>
      ) : (
        <div className="flex-1 min-w-0">
          <SessionRowContent
            session={session}
            gs={gs}
            iconColor={iconColor}
            hasDiff={hasDiff}
            adds={adds}
            dels={dels}
            branch={branch}
            statusText={statusText}
            statusColor={statusColor}
            globalIndex={globalIndex}
          />
        </div>
      )}

      {/* Archive button - on hover */}
      <button
        onClick={(e) => { e.stopPropagation(); onArchive(); }}
        className="flex-shrink-0 p-1 rounded text-text-muted hover:text-status-error hover:bg-surface-hover transition-all opacity-0 group-hover/session:opacity-100"
        title="Archive"
      >
        <Archive className="w-4 h-4" />
      </button>
    </div>
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
