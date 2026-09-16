import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, MessageSquare, Plus, RefreshCw, Terminal } from 'lucide-react';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { usePanelStore } from '../stores/panelStore';
import { useConfigStore } from '../stores/configStore';
import {
  useOrchestrationSessionStore,
  type OrchestrationSessionAvailability,
} from '../stores/orchestrationSessionStore';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { DEFAULT_PANE_CHAT_AGENT, type PaneChatAgent } from '../../../shared/types/paneChat';
import { LEGACY_ORCHESTRATION_SESSION_ID } from '../../../shared/types/orchestrationSession';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { AgentStatusDot } from './ui/AgentStatusDot';
import { rollupAgentDisplayStatus, rollupSessionAgentState, toAgentDisplayStatus } from '../utils/agentStatus';
import { visibleAgentPresets } from '../utils/agentPresets';
import { cn } from '../utils/cn';

interface OrchestrationSessionNavProps {
  compact?: boolean;
  /** Pane IDs that are still present in the normal Pane list. */
  availablePaneIds?: ReadonlySet<string>;
  /** Renders an associated Pane with the existing Pane row experience. */
  renderPane?: (paneId: string, parentSessionId: string, index: number) => ReactNode | null;
}

function statusLabel(session: OrchestrationSessionRecord): string {
  if (session.blockers.length > 0) return 'Blocked';
  if (session.report) return 'Report available';
  return 'No report yet';
}

function availabilityIsVisible(availability: OrchestrationSessionAvailability): boolean {
  return availability === 'ready' || availability === 'loading' || availability === 'error';
}

const SESSION_AGENT_OPTIONS: ReadonlyArray<{ id: PaneChatAgent; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

function availableSessionAgents(): ReadonlyArray<{ id: PaneChatAgent; label: string }> {
  const visible = new Set(visibleAgentPresets().map(preset => preset.id));
  return SESSION_AGENT_OPTIONS.filter(option => visible.has(option.id));
}

function nextSessionName(sessions: readonly OrchestrationSessionRecord[]): string {
  const existingNames = new Set(sessions.map(session => session.name.trim().toLocaleLowerCase()));
  if (!existingNames.has('new chat')) return 'New chat';

  let suffix = 2;
  while (existingNames.has(`new chat ${suffix}`)) suffix += 1;
  return `New chat ${suffix}`;
}

function useAggregateSessionStatus(sessions: OrchestrationSessionRecord[]) {
  return usePanelStore(state => rollupAgentDisplayStatus(
    sessions.map(session => {
      if (session.blockers.length > 0) return 'blocked';
      return toAgentDisplayStatus(
        rollupSessionAgentState(state.agentStatus, state.agentStatusSession, session.internalSessionId),
        Boolean(state.unviewedCompletedActivity[session.internalSessionId]),
      );
    }),
  ));
}

/** Top-level shortcut that keeps the expanded sidebar's navigation compact. */
export function OrchestrationSessionShortcut() {
  const sessions = useOrchestrationSessionStore(state => state.sessions);
  const availability = useOrchestrationSessionStore(state => state.availability);
  const aggregateStatus = useAggregateSessionStatus(sessions);
  const navigateToPaneChat = useNavigationStore(state => state.navigateToPaneChat);
  const activeView = useNavigationStore(state => state.activeView);
  const setActiveSession = useSessionStore(state => state.setActiveSession);

  if (!availabilityIsVisible(availability)) return null;

  return (
    <button
      type="button"
      data-testid="sessions-nav"
      onClick={() => {
        setActiveSession(null);
        navigateToPaneChat();
      }}
      className={cn(
        'flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive',
        activeView === 'pane-chat' ? 'bg-surface-hover text-text-primary' : 'text-text-secondary',
      )}
    >
      <MessageSquare className="h-4 w-4" />
      <span>Sessions</span>
      <AgentStatusDot status={aggregateStatus} size="sm" className="ml-auto" />
    </button>
  );
}

export function OrchestrationSessionNav({ compact = false, availablePaneIds, renderPane }: OrchestrationSessionNavProps) {
  const sessions = useOrchestrationSessionStore(state => state.sessions);
  const selectedSessionId = useOrchestrationSessionStore(state => state.selectedSessionId);
  const availability = useOrchestrationSessionStore(state => state.availability);
  const error = useOrchestrationSessionStore(state => state.error);
  const load = useOrchestrationSessionStore(state => state.load);
  const refresh = useOrchestrationSessionStore(state => state.refresh);
  const select = useOrchestrationSessionStore(state => state.select);
  const create = useOrchestrationSessionStore(state => state.create);
  const navigateToPaneChat = useNavigationStore(state => state.navigateToPaneChat);
  const activeView = useNavigationStore(state => state.activeView);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const [showCreate, setShowCreate] = useState(false);
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(new Set());

  const createSession = useCallback(async (agent: PaneChatAgent) => {
    await load();
    const name = nextSessionName(useOrchestrationSessionStore.getState().sessions);
    await create({ name, agent });
    setShowCreate(false);
    setActiveSession(null);
    navigateToPaneChat();
  }, [create, load, navigateToPaneChat, setActiveSession]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleSessionsChanged = (event: Event) => {
      const adoptServerSelection = event instanceof CustomEvent
        && event.detail?.kind === 'selected';
      void refresh({ adoptServerSelection });
    };
    window.addEventListener('orchestration-sessions-changed', handleSessionsChanged);
    return () => window.removeEventListener('orchestration-sessions-changed', handleSessionsChanged);
  }, [refresh]);

  const openSession = useCallback(async (sessionId: string) => {
    try {
      await select({ sessionId });
      setActiveSession(null);
      navigateToPaneChat();
    } catch {
      // The navigation store retains the last known record; the next load
      // exposes the daemon error in the navigation surface.
    }
  }, [navigateToPaneChat, select, setActiveSession]);

  if (!availabilityIsVisible(availability)) return null;

  if (compact) {
    return (
      <div role="group" aria-label="Sessions" className="flex w-full shrink-0 flex-col items-center gap-0.5">
        <Tooltip content="Sessions" side="right">
          <button
            type="button"
            data-testid="compact-sessions"
            data-compact-rail-item
            aria-label="Sessions"
            onClick={() => {
              setActiveSession(null);
              navigateToPaneChat();
            }}
            className={cn(
              'relative flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded transition-colors focus:outline-none focus:ring-2 focus:ring-interactive',
              'text-text-tertiary hover:bg-surface-hover hover:text-text-primary',
              activeView === 'pane-chat' && 'bg-surface-selected text-text-primary',
            )}
          >
            <MessageSquare className="h-4 w-4" />
            {availability === 'loading' && <RefreshCw className="absolute right-0 top-0 h-2.5 w-2.5 animate-spin" />}
          </button>
        </Tooltip>
        <Tooltip content="New Session" side="right">
          <button
            type="button"
            data-testid="compact-new-orchestration-session"
            data-compact-rail-item
            aria-label="New Session"
            onClick={() => setShowCreate(true)}
            className="flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"
          >
            <Plus className="h-4 w-4" />
          </button>
        </Tooltip>
        {sessions.map(session => (
          <Tooltip key={session.id} content={`${session.name} · ${statusLabel(session)}`} side="right">
            <button
              type="button"
              data-testid={session.id === LEGACY_ORCHESTRATION_SESSION_ID ? 'compact-pane-chat' : `compact-orchestration-session-${session.id}`}
              data-compact-rail-item
              aria-label={session.id === LEGACY_ORCHESTRATION_SESSION_ID ? 'Pane Chat' : `Open Session ${session.name}`}
              title={session.name}
              onClick={() => void openSession(session.id)}
              className={cn(
                'flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-interactive',
                session.id === selectedSessionId ? 'bg-surface-selected text-text-primary' : 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary',
              )}
            >
              {session.name.trim().charAt(0).toUpperCase() || <Terminal className="h-4 w-4" />}
            </button>
          </Tooltip>
        ))}
        {error && (
          <Tooltip content={error} side="right">
            <button
              type="button"
              data-testid="compact-sessions-error"
              data-compact-rail-item
              aria-label="Sessions unavailable"
              onClick={() => void load()}
              className="flex h-9 w-9 items-center justify-center rounded text-status-error hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
        <CreateOrchestrationSessionDialog isOpen={showCreate} onClose={() => setShowCreate(false)} onCreate={createSession} />
      </div>
    );
  }

  return (
    <>
      <div className="mt-1" role="group" aria-label="Sessions">
        <div className="flex items-center justify-between gap-2 pl-3 pr-2 py-0.5">
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide leading-4 text-text-tertiary">Sessions</span>
          <button
            type="button"
            data-testid="new-orchestration-session"
            aria-label="New Session"
            title="New Session"
            onClick={() => setShowCreate(true)}
            className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        {availability === 'loading' && (
          <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-text-muted" role="status">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Loading Sessions…
          </div>
        )}
        {error && (
          <div className="mx-3 mb-1 rounded border border-status-error/40 bg-status-error/10 px-2 py-1.5 text-[11px] text-status-error" role="alert">
            <p>{error}</p>
            <button type="button" className="mt-1 underline" onClick={() => void load()}>Retry</button>
          </div>
        )}
        {availability === 'ready' && sessions.length === 0 && (
          <p className="px-4 py-1 text-[11px] text-text-muted">Create a Session to keep intent and discussion together.</p>
        )}
        {sessions.map(session => {
          const visibleAssociations = session.associations.filter(association => (
            !availablePaneIds || availablePaneIds.has(association.paneId)
          ));
          const paneRows = renderPane
            ? visibleAssociations
              .map((association, index) => renderPane(association.paneId, session.id, index))
              .filter((row): row is ReactNode => row !== null && row !== undefined)
            : [];
          const expanded = !collapsedSessionIds.has(session.id);
          const isLegacy = session.id === LEGACY_ORCHESTRATION_SESSION_ID;
          const label = session.name || 'Pane Chat';

          return (
            <div key={session.id} className="group/orchestration-session">
              <div className={cn(
                'flex h-8 w-full items-center gap-0.5 text-[13px] transition-colors',
                activeView === 'pane-chat' && session.id === selectedSessionId ? 'bg-surface-selected text-text-primary' : 'text-text-secondary hover:bg-surface-hover',
              )}>
                {paneRows.length > 0 ? (
                  <button
                    type="button"
                    data-testid={`orchestration-session-toggle-${session.id}`}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} Session ${label}`}
                    aria-expanded={expanded}
                    aria-controls={`orchestration-session-panes-${session.id}`}
                    onClick={() => setCollapsedSessionIds(current => {
                      const next = new Set(current);
                      if (next.has(session.id)) next.delete(session.id);
                      else next.add(session.id);
                      return next;
                    })}
                    className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
                  >
                    {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                ) : (
                  <span aria-hidden="true" className="inline-flex h-6 w-6 flex-shrink-0" />
                )}
                <button
                  type="button"
                  data-testid={isLegacy ? 'orchestration-pane-chat' : `orchestration-session-${session.id}`}
                  aria-label={isLegacy ? label : `Open Session ${session.name}`}
                  onClick={() => void openSession(session.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
                >
                  <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {paneRows.length > 0 && <span className="pr-1 text-[10px] tabular-nums text-text-muted">{paneRows.length}</span>}
                </button>
              </div>
              {expanded && paneRows.length > 0 && (
                <div id={`orchestration-session-panes-${session.id}`} className="ml-4 border-l border-border-primary">
                  {paneRows}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <CreateOrchestrationSessionDialog isOpen={showCreate} onClose={() => setShowCreate(false)} onCreate={createSession} />
    </>
  );
}

interface CreateOrchestrationSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (agent: PaneChatAgent) => Promise<void>;
}

function CreateOrchestrationSessionDialog({ isOpen, onClose, onCreate }: CreateOrchestrationSessionDialogProps) {
  const [agent, setAgent] = useState<PaneChatAgent>(DEFAULT_PANE_CHAT_AGENT);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const config = useConfigStore(state => state.config);
  const fetchConfig = useConfigStore(state => state.fetchConfig);
  const updateConfig = useConfigStore(state => state.updateConfig);
  const userSelectedAgent = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    userSelectedAgent.current = false;
    setAgent(useConfigStore.getState().config?.defaultOrchestratorAgent ?? DEFAULT_PANE_CHAT_AGENT);
    setError(null);
    if (!useConfigStore.getState().config) {
      void fetchConfig().then(nextConfig => {
        if (!userSelectedAgent.current && nextConfig.defaultOrchestratorAgent) setAgent(nextConfig.defaultOrchestratorAgent);
      }).catch(() => undefined);
    }
  }, [fetchConfig, isOpen]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      if (config?.defaultOrchestratorAgent !== agent) {
        await updateConfig({ defaultOrchestratorAgent: agent });
      }
      await onCreate(agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to create Session');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" ariaLabel="Create Session">
      <form onSubmit={submit}>
        <ModalHeader title="Create Session" />
        <ModalBody>
          <fieldset className="space-y-2">
            <legend className="text-label font-medium text-text-primary">Choose an agent</legend>
            <div className="grid gap-2" role="radiogroup" aria-label="Session agent">
              {availableSessionAgents().map(option => {
                const selected = agent === option.id;
                const isDefault = config?.defaultOrchestratorAgent === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`create-session-agent-${option.id}`}
                    onClick={() => {
                      userSelectedAgent.current = true;
                      setAgent(option.id);
                    }}
                    className={cn(
                      'flex items-center justify-between rounded border px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-interactive',
                      selected ? 'border-interactive bg-surface-selected text-text-primary' : 'border-border-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                    )}
                  >
                    <span>{option.label}</span>
                    {isDefault && <span className="text-[11px] text-text-muted">Default</span>}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={isSubmitting} loadingText="Creating…">Create Session</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
