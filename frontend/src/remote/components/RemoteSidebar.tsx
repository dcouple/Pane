import { Archive, Monitor, Pin, Plus, RefreshCw, TerminalSquare, X } from 'lucide-react';
import { useMemo } from 'react';
import type { RemoteProjectWithSessions } from '../runtime/remoteRuntimeAdapter';
import type { Session } from '../../types/session';
import { RemoteDesktopLink } from './RemoteDesktopLink';

interface RemoteSidebarProps {
  projects: RemoteProjectWithSessions[];
  selectedSessionId: string | null;
  loading: boolean;
  actionSessionId?: string | null;
  onSelectSession: (sessionId: string) => void;
  onTogglePinned: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onCreateSession: (project: RemoteProjectWithSessions) => void;
  onRefresh: () => void;
  onClose?: () => void;
  className?: string;
}

export function RemoteSidebar({
  projects,
  selectedSessionId,
  loading,
  actionSessionId = null,
  onSelectSession,
  onTogglePinned,
  onArchiveSession,
  onCreateSession,
  onRefresh,
  onClose,
  className = 'flex w-80 shrink-0',
}: RemoteSidebarProps) {
  const pinnedSessions = useMemo(() => {
    return projects
      .flatMap(project => (project.sessions ?? [])
        .filter(session => !session.archived && session.isFavorite)
        .map(session => ({
          session,
          label: getPinnedSessionLabel(project, session),
        })))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }, [projects]);

  return (
    <aside className={`${className} min-h-0 flex-col border-r border-border-primary bg-surface-primary`}>
      <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-border-primary px-4 py-2">
        <div className="flex items-center gap-2">
          <TerminalSquare className="h-5 w-5 text-interactive" />
          <span className="font-semibold text-text-primary">Remote Pane</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
            aria-label="Refresh remote sessions"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary md:hidden"
              aria-label="Close remote panes"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="shrink-0 border-b border-border-primary p-3">
        <RemoteDesktopLink />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {projects.length === 0 && !loading && (
          <div className="rounded-md border border-border-primary bg-surface-secondary p-4 text-sm text-text-secondary">
            No remote panes found on this host.
          </div>
        )}

        {pinnedSessions.length > 0 && (
          <div className="mb-4">
            <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              Pinned
            </div>
            <div className="space-y-1">
              {pinnedSessions.map(({ session, label }) => (
                <RemoteSessionRow
                  key={`pinned-${session.id}`}
                  session={session}
                  label={label}
                  selected={selectedSessionId === session.id}
                  busy={actionSessionId === session.id}
                  onSelect={() => onSelectSession(session.id)}
                  onTogglePinned={() => onTogglePinned(session.id)}
                  onArchive={() => onArchiveSession(session.id)}
                />
              ))}
            </div>
          </div>
        )}

        {projects.map(project => (
          <div key={project.id} className="mb-4">
            <div className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              <Monitor className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <button
                type="button"
                onClick={() => onCreateSession(project)}
                className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
                title={`New pane in ${project.name}`}
                aria-label={`New pane in ${project.name}`}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1">
              {(project.sessions ?? []).map(session => (
                <RemoteSessionRow
                  key={session.id}
                  session={session}
                  label={session.name}
                  selected={selectedSessionId === session.id}
                  busy={actionSessionId === session.id}
                  onSelect={() => onSelectSession(session.id)}
                  onTogglePinned={() => onTogglePinned(session.id)}
                  onArchive={() => onArchiveSession(session.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

interface RemoteSessionRowProps {
  session: Session;
  label: string;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
}

function RemoteSessionRow({
  session,
  label,
  selected,
  busy,
  onSelect,
  onTogglePinned,
  onArchive,
}: RemoteSessionRowProps) {
  return (
    <div
      className={`group flex w-full items-center justify-between gap-2 rounded-md px-3 py-3 text-left text-sm transition-colors md:py-2 ${
        selected
          ? 'bg-interactive-surface text-text-primary'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {session.status === 'running' && (
          <span className="hidden shrink-0 rounded-sm border border-status-success/30 bg-status-success/10 px-1.5 py-0.5 text-[10px] text-status-success sm:inline">
            running
          </span>
        )}
      </button>
      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          disabled={busy}
          onClick={onTogglePinned}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            session.isFavorite
              ? 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary'
              : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
          }`}
          title={session.isFavorite ? 'Unpin' : 'Pin'}
          aria-label={session.isFavorite ? 'Unpin pane' : 'Pin pane'}
        >
          <Pin className="h-3.5 w-3.5 rotate-45" />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onArchive}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50"
          title="Archive"
          aria-label="Archive pane"
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

function getPinnedSessionLabel(project: RemoteProjectWithSessions, session: Session): string {
  return `${project.name || 'Unknown'}/${session.name || 'Untitled'}`;
}
