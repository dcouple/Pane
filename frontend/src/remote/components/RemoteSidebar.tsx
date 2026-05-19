import { Monitor, RefreshCw, TerminalSquare, X } from 'lucide-react';
import type { RemoteProjectWithSessions } from '../runtime/remoteRuntimeAdapter';
import { RemoteDesktopLink } from './RemoteDesktopLink';

interface RemoteSidebarProps {
  projects: RemoteProjectWithSessions[];
  selectedSessionId: string | null;
  loading: boolean;
  onSelectSession: (sessionId: string) => void;
  onRefresh: () => void;
  onClose?: () => void;
  className?: string;
}

export function RemoteSidebar({
  projects,
  selectedSessionId,
  loading,
  onSelectSession,
  onRefresh,
  onClose,
  className = 'flex w-80 shrink-0',
}: RemoteSidebarProps) {
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

        {projects.map(project => (
          <div key={project.id} className="mb-4">
            <div className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              <Monitor className="h-3.5 w-3.5" />
              <span className="truncate">{project.name}</span>
            </div>
            <div className="space-y-1">
              {(project.sessions ?? []).map(session => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelectSession(session.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-3 text-left text-sm transition-colors md:py-2 ${
                    selectedSessionId === session.id
                      ? 'bg-interactive-surface text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`}
                >
                  <span className="truncate font-medium">{session.name}</span>
                  {session.status === 'running' && (
                    <span className="shrink-0 rounded-sm border border-status-success/30 bg-status-success/10 px-1.5 py-0.5 text-[10px] text-status-success">
                      running
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
