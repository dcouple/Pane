import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Save, Terminal, X } from 'lucide-react';
import { API } from '../utils/api';
import type { Session } from '../types/session';
import type { PaneChatAgent, PaneChatState } from '../../../shared/types/paneChat';
import type {
  OrchestrationSessionOverview,
  OrchestrationSessionRecord,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import { SessionProvider } from '../contexts/SessionContext';
import { PanelContainer } from './panels/PanelContainer';
import { Button } from './ui/Button';
import { Input, Textarea } from './ui/Input';
import { ClaudeIcon, CursorIcon, OpenAIIcon } from './ui/BrandIcons';
import { cn } from '../utils/cn';
import { LiveRegion } from './ui/LiveRegion';
import { visibleAgentPresets } from '../utils/agentPresets';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';

const ALL_PANE_CHAT_AGENT_OPTIONS: Array<{
  id: PaneChatAgent;
  label: string;
  icon: typeof ClaudeIcon;
}> = [
  { id: 'claude', label: 'Claude', icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', icon: OpenAIIcon },
  { id: 'cursor', label: 'Cursor', icon: CursorIcon },
];

const PANE_CHAT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
} satisfies Record<PaneChatAgent, string>;

function availableAgentOptions(): typeof ALL_PANE_CHAT_AGENT_OPTIONS {
  const visible = new Set(visibleAgentPresets().map(preset => preset.id));
  return ALL_PANE_CHAT_AGENT_OPTIONS.filter(option => visible.has(option.id));
}

function responseError(response: { success: boolean; error?: string }, fallback: string): Error | null {
  return response.success ? null : new Error(response.error || fallback);
}

export function PaneChatView() {
  const [legacyState, setLegacyState] = useState<PaneChatState<Session> | null>(null);
  const [namedView, setNamedView] = useState<OrchestrationSessionView<Session> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [switchingAgent, setSwitchingAgent] = useState<PaneChatAgent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const requestGeneration = useRef(0);

  const availability = useOrchestrationSessionStore(state => state.availability);
  const selectedSessionId = useOrchestrationSessionStore(state => state.selectedSessionId);
  const loadSessions = useOrchestrationSessionStore(state => state.load);
  const updateSession = useOrchestrationSessionStore(state => state.update);
  const selectSession = useOrchestrationSessionStore(state => state.select);

  const loadLegacyPaneChat = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await API.paneChat.getOrCreate();
      const responseFailure = responseError(response, 'Failed to open Pane Chat');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to open Pane Chat');
      setLegacyState(response.data);
      setNamedView(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to open Pane Chat');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadNamedSession = useCallback(async (sessionId?: string) => {
    const generation = ++requestGeneration.current;
    setIsLoading(true);
    setError(null);
    try {
      await loadSessions();
      const current = useOrchestrationSessionStore.getState();
      if (current.availability === 'error') throw new Error(current.error || 'Sessions could not be loaded');
      const targetId = sessionId ?? current.selectedSessionId ?? current.sessions[0]?.id;
      if (!targetId) throw new Error('No Sessions have been created yet');
      if (targetId !== current.selectedSessionId) {
        await selectSession({ sessionId: targetId });
      }
      const response = await API.orchestrationSessions.get({ sessionId: targetId });
      const responseFailure = responseError(response, 'Failed to open Session');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to open Session');
      if (generation !== requestGeneration.current) return;
      setNamedView(response.data);
      setLegacyState(null);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setError(cause instanceof Error ? cause.message : 'Failed to open Session');
      setNamedView(null);
      setLegacyState(null);
    } finally {
      if (generation === requestGeneration.current) setIsLoading(false);
    }
  }, [loadSessions, selectSession]);

  useEffect(() => {
    const hasNamedSessionApi = Boolean(window.electronAPI?.orchestrationSessions);
    if (!hasNamedSessionApi) {
      void loadLegacyPaneChat();
      return;
    }
    void loadNamedSession();
  }, [loadLegacyPaneChat, loadNamedSession]);

  useEffect(() => {
    if (!window.electronAPI?.orchestrationSessions || !selectedSessionId) return;
    if (namedView?.session.id === selectedSessionId) return;
    void loadNamedSession(selectedSessionId);
  }, [loadNamedSession, namedView?.session.id, selectedSessionId]);

  useEffect(() => {
    const handleChanged = () => {
      if (window.electronAPI?.orchestrationSessions) void loadNamedSession(selectedSessionId);
    };
    window.addEventListener('orchestration-sessions-changed', handleChanged);
    return () => window.removeEventListener('orchestration-sessions-changed', handleChanged);
  }, [loadNamedSession, selectedSessionId]);

  const handleLegacyAgentChange = useCallback(async (agent: PaneChatAgent) => {
    if (!legacyState || legacyState.agent === agent || switchingAgent) return;
    setSwitchingAgent(agent);
    setError(null);
    setStatusAnnouncement(`Switching Pane Chat to ${PANE_CHAT_AGENT_LABELS[agent]}`);
    try {
      const response = await API.paneChat.setAgent(agent);
      const responseFailure = responseError(response, 'Failed to switch Pane Chat agent');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to switch Pane Chat agent');
      setLegacyState(response.data);
      setStatusAnnouncement(`Pane Chat is now using ${PANE_CHAT_AGENT_LABELS[agent]}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to switch Pane Chat agent');
    } finally {
      setSwitchingAgent(null);
    }
  }, [legacyState, switchingAgent]);

  const handleNamedAgentChange = useCallback(async (agent: PaneChatAgent) => {
    if (!namedView || namedView.agent === agent || switchingAgent) return;
    const sessionId = namedView.session.id;
    const generation = requestGeneration.current;
    setSwitchingAgent(agent);
    setError(null);
    setStatusAnnouncement(`Switching ${namedView.session.name} to ${PANE_CHAT_AGENT_LABELS[agent]}`);
    try {
      const response = await API.orchestrationSessions.setAgent({ sessionId }, agent);
      const responseFailure = responseError(response, 'Failed to switch Session agent');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to switch Session agent');
      if (generation !== requestGeneration.current || useOrchestrationSessionStore.getState().selectedSessionId !== sessionId) return;
      setNamedView(response.data);
      await loadSessions();
      if (generation === requestGeneration.current && useOrchestrationSessionStore.getState().selectedSessionId === sessionId) {
        setStatusAnnouncement(`${namedView.session.name} is now using ${PANE_CHAT_AGENT_LABELS[agent]}`);
      }
    } catch (cause) {
      if (generation === requestGeneration.current && useOrchestrationSessionStore.getState().selectedSessionId === sessionId) {
        setError(cause instanceof Error ? cause.message : 'Failed to switch Session agent');
      }
    } finally {
      if (generation === requestGeneration.current && useOrchestrationSessionStore.getState().selectedSessionId === sessionId) {
        setSwitchingAgent(null);
      }
    }
  }, [loadSessions, namedView, switchingAgent]);

  const handleNamedOverviewUpdate = useCallback(async (input: OrchestrationSessionUpdateInput): Promise<OrchestrationSessionRecord> => {
    if (!namedView) throw new Error('No Session selected');
    const sessionId = namedView.session.id;
    const generation = requestGeneration.current;
    const record = await updateSession({ sessionId }, {
      ...input,
      expectedRevision: namedView.session.revision,
    });
    if (generation !== requestGeneration.current || useOrchestrationSessionStore.getState().selectedSessionId !== sessionId) {
      throw new Error('Session selection changed while saving the overview');
    }
    setNamedView(current => current ? { ...current, session: record } : current);
    setStatusAnnouncement(`${record.name} overview saved`);
    return record;
  }, [namedView, updateSession]);

  if (isLoading && !legacyState && !namedView) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary text-text-secondary">
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
          <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" />
          <span>{availability === 'unavailable' ? 'Opening Pane Chat…' : 'Opening Sessions…'}</span>
        </div>
      </div>
    );
  }

  if (legacyState) {
    return (
      <LegacyPaneChatWorkspace
        state={legacyState}
        error={error}
        statusAnnouncement={statusAnnouncement}
        switchingAgent={switchingAgent}
        onAgentChange={handleLegacyAgentChange}
        onRetry={loadLegacyPaneChat}
      />
    );
  }

  if (!namedView) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary p-6">
        <div className="max-w-md text-center">
          <Terminal className="mx-auto mb-3 h-8 w-8 text-text-tertiary" />
          <h2 className="text-base font-semibold text-text-primary">Sessions did not open</h2>
          <p role="alert" className="mt-2 text-sm text-text-secondary">{error ?? 'No Session is selected.'}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4"
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => void loadNamedSession()}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <NamedSessionWorkspace
      key={namedView.session.id}
      view={namedView}
      error={error}
      statusAnnouncement={statusAnnouncement}
      switchingAgent={switchingAgent}
      onAgentChange={handleNamedAgentChange}
      onOverviewUpdate={handleNamedOverviewUpdate}
      onRetry={() => void loadNamedSession(namedView.session.id)}
    />
  );
}

interface AgentChoiceProps {
  selected: PaneChatAgent;
  switchingAgent: PaneChatAgent | null;
  label: string;
  inputName: string;
  onChange: (agent: PaneChatAgent) => void;
}

function AgentChoice({ selected, switchingAgent, label, inputName, onChange }: AgentChoiceProps) {
  return (
    <fieldset className="flex h-8 flex-shrink-0 items-center rounded-md border border-border-secondary bg-surface-secondary p-0.5">
      <legend className="sr-only">{label} agent</legend>
      {availableAgentOptions().map(option => {
        const Icon = switchingAgent === option.id ? RefreshCw : option.icon;
        const isSelected = selected === option.id;
        return (
          <label
            key={option.id}
            className={cn(
              'relative inline-flex h-7 min-w-[76px] cursor-pointer items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-interactive',
              switchingAgent !== null && 'cursor-not-allowed opacity-70',
              isSelected ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
            )}
          >
            <input
              type="radio"
              name={inputName}
              value={option.id}
              checked={isSelected}
              aria-disabled={switchingAgent !== null || undefined}
              onChange={() => onChange(option.id)}
              className="sr-only"
            />
            <Icon className={cn('h-3.5 w-3.5', switchingAgent === option.id && 'animate-spin')} />
            <span>{option.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

interface LegacyPaneChatWorkspaceProps {
  state: PaneChatState<Session>;
  error: string | null;
  statusAnnouncement: string;
  switchingAgent: PaneChatAgent | null;
  onAgentChange: (agent: PaneChatAgent) => void;
  onRetry: () => void;
}

function LegacyPaneChatWorkspace({ state, error, statusAnnouncement, switchingAgent, onAgentChange, onRetry }: LegacyPaneChatWorkspaceProps) {
  return (
    <div className="pane-chat-shell flex-1 flex flex-col overflow-hidden bg-bg-primary">
      <LiveRegion>{statusAnnouncement}</LiveRegion>
      <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border-primary px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
          <h1 className="truncate text-sm font-semibold text-text-primary">Pane Chat</h1>
          {error && <span role="alert" className="truncate text-xs text-status-error">{error}</span>}
        </div>
        <AgentChoice selected={state.agent} switchingAgent={switchingAgent} label="Pane Chat" inputName="pane-chat-agent" onChange={onAgentChange} />
      </div>
      <SessionProvider session={state.session}>
        <div className="min-h-0 flex-1 overflow-hidden">
          <PanelContainer panel={state.panel} isActive={true} autoFocus={true} />
        </div>
      </SessionProvider>
      {error && <button type="button" className="sr-only" onClick={onRetry}>Retry Pane Chat</button>}
    </div>
  );
}

interface NamedSessionWorkspaceProps {
  view: OrchestrationSessionView<Session>;
  error: string | null;
  statusAnnouncement: string;
  switchingAgent: PaneChatAgent | null;
  onAgentChange: (agent: PaneChatAgent) => void;
  onOverviewUpdate: (input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
  onRetry: () => void;
}

function NamedSessionWorkspace({ view, error, statusAnnouncement, switchingAgent, onAgentChange, onOverviewUpdate, onRetry }: NamedSessionWorkspaceProps) {
  const [overview, setOverview] = useState<OrchestrationSessionOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [showOverview, setShowOverview] = useState(true);

  const refreshOverview = useCallback(async () => {
    try {
      const response = await API.orchestrationSessions.overview({ sessionId: view.session.id });
      const responseFailure = responseError(response, 'Failed to refresh Session overview');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to refresh Session overview');
      setOverview(response.data);
      setOverviewError(null);
    } catch (cause) {
      setOverviewError(cause instanceof Error ? cause.message : 'Failed to refresh Session overview');
    }
  }, [view.session.id]);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  useEffect(() => {
    const handleRefresh = () => void refreshOverview();
    window.addEventListener('orchestration-sessions-overview-updated', handleRefresh);
    return () => window.removeEventListener('orchestration-sessions-overview-updated', handleRefresh);
  }, [refreshOverview]);

  return (
    <div className="pane-chat-shell flex-1 flex min-h-0 flex-col overflow-hidden bg-bg-primary">
      <LiveRegion>{statusAnnouncement}</LiveRegion>
      <div className="flex min-h-11 flex-shrink-0 items-center justify-between gap-3 border-b border-border-primary px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-text-primary">{view.session.name}</h1>
            <p className="truncate text-[11px] text-text-muted">{view.session.goal || 'Session conversation'}</p>
          </div>
          {error && <span role="alert" className="truncate text-xs text-status-error">{error}</span>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowOverview(value => !value)} aria-expanded={showOverview}>
            {showOverview ? 'Hide overview' : 'Show overview'}
          </Button>
          <AgentChoice selected={view.agent} switchingAgent={switchingAgent} label={view.session.name} inputName={`orchestration-agent-${view.session.id}`} onChange={onAgentChange} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SessionProvider session={view.internalSession}>
          <div className="min-w-0 flex-1 overflow-hidden">
            <PanelContainer key={view.panel.id} panel={view.panel} isActive={true} autoFocus={true} />
          </div>
        </SessionProvider>
        {showOverview && (
          <SessionOverviewPanel
            record={view.session}
            overview={overview}
            error={overviewError}
            onRefresh={refreshOverview}
            onUpdate={async input => {
              const record = await onOverviewUpdate(input);
              await refreshOverview();
              return record;
            }}
            onRetry={onRetry}
          />
        )}
      </div>
    </div>
  );
}

interface SessionOverviewPanelProps {
  record: OrchestrationSessionRecord;
  overview: OrchestrationSessionOverview | null;
  error: string | null;
  onRefresh: () => Promise<void>;
  onUpdate: (input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
  onRetry: () => void;
}

function SessionOverviewPanel({ record, overview, error, onRefresh, onUpdate, onRetry }: SessionOverviewPanelProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(record.name);
  const [goal, setGoal] = useState(record.goal);
  const [context, setContext] = useState(record.context);
  const [decisions, setDecisions] = useState(record.decisions.join('\n'));
  const [blockers, setBlockers] = useState(record.blockers.join('\n'));
  const [nextAction, setNextAction] = useState(record.nextAction);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    setName(record.name);
    setGoal(record.goal);
    setContext(record.context);
    setDecisions(record.decisions.join('\n'));
    setBlockers(record.blockers.join('\n'));
    setNextAction(record.nextAction);
  }, [editing, record]);

  const save = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await onUpdate({
        name,
        goal,
        context,
        decisions: splitLines(decisions),
        blockers: splitLines(blockers),
        nextAction,
      });
      setEditing(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Failed to save Session overview');
    } finally {
      setIsSaving(false);
    }
  };

  const report = overview ? overview.report : record.report;
  const reportFreshness = overview?.report?.freshness ?? 'pending';

  return (
    <aside className="flex w-[min(360px,38vw)] min-w-[280px] flex-shrink-0 flex-col overflow-y-auto border-l border-border-primary bg-surface-primary" aria-label="Session overview">
      <div className="flex items-center justify-between gap-2 border-b border-border-primary px-3 py-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Overview</h2>
          <p className="text-[10px] text-text-muted">Revision {record.revision}</p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Refresh Session overview" title="Refresh" onClick={() => void onRefresh()} className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"><RefreshCw className="h-3.5 w-3.5" /></button>
          <button type="button" aria-label={editing ? 'Cancel editing Session overview' : 'Edit Session overview'} title={editing ? 'Cancel editing' : 'Edit overview'} onClick={() => setEditing(value => !value)} className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive">{editing ? <X className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}</button>
        </div>
      </div>
      <div className="space-y-3 p-3 text-xs">
        {editing ? (
          <>
            <Input label="Name" value={name} onChange={event => setName(event.target.value)} fullWidth />
            <Textarea label="Goal" value={goal} onChange={event => setGoal(event.target.value)} rows={2} fullWidth />
            <Textarea label="Context" value={context} onChange={event => setContext(event.target.value)} rows={3} fullWidth />
            <Textarea label="Decisions" helperText="One decision per line" value={decisions} onChange={event => setDecisions(event.target.value)} rows={3} fullWidth />
            <Textarea label="Blockers" helperText="One blocker per line" value={blockers} onChange={event => setBlockers(event.target.value)} rows={3} fullWidth />
            <Input label="Next action" value={nextAction} onChange={event => setNextAction(event.target.value)} fullWidth />
            {saveError && <p role="alert" className="text-status-error">{saveError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="button" size="sm" loading={isSaving} loadingText="Saving…" onClick={() => void save()}>Save overview</Button>
            </div>
          </>
        ) : (
          <>
            <OverviewText label="Goal" value={record.goal} empty="No goal recorded." />
            <OverviewText label="Context" value={record.context} empty="No context recorded." />
            <OverviewList label="Decisions" values={record.decisions} empty="No decisions recorded." />
            <OverviewList label="Blockers" values={record.blockers} empty="No blockers recorded." />
            <OverviewText label="Next action" value={record.nextAction} empty="No next action recorded." />
          </>
        )}

        <div className="border-t border-border-primary pt-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Associated Panes</h3>
          {!overview && !error && <p className="text-text-muted">Loading live state…</p>}
          {error && <div className="space-y-1"><p role="alert" className="text-status-error">{error}</p><button type="button" className="underline text-text-secondary" onClick={onRetry}>Retry</button></div>}
          {overview?.panes.length === 0 && <p className="text-text-muted">This Session has no associated Panes.</p>}
          {overview?.panes.map(pane => <PaneOverviewCard key={pane.paneId} pane={pane} />)}
        </div>

        <div className="border-t border-border-primary pt-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Evidence and outputs</h3>
          <LinkList links={[...record.evidence, ...record.outputs]} />
          {report && (
            <div className="mt-2 rounded border border-border-primary bg-surface-secondary p-2">
              <p className="font-medium text-text-primary">{report.summary}</p>
              <p className="mt-1 text-[10px] text-text-muted">{report.status === 'verified' ? 'Marked verified by source' : 'Reported by source'} · {report.provenance} · {reportFreshness === 'stale' ? 'stale after later activity' : reportFreshness === 'current' ? 'current at last refresh' : 'freshness pending'}</p>
              <LinkList links={report.evidence} />
            </div>
          )}
        </div>

        <div className="border-t border-border-primary pt-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Activity</h3>
          <div className="space-y-2">
            {(overview?.activity ?? record.activity).slice(0, 12).map(activity => (
              <div key={activity.id} className="border-l-2 border-border-primary pl-2">
                <p className="text-text-secondary">{activity.message}</p>
                <p className="mt-0.5 text-[10px] text-text-muted">{formatActivityTime(activity.at)} · {activity.source}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function OverviewText({ label, value, empty }: { label: string; value: string; empty: string }) {
  return <div><h3 className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{label}</h3><p className={cn('whitespace-pre-wrap leading-relaxed', value ? 'text-text-secondary' : 'text-text-muted')}>{value || empty}</p></div>;
}

function OverviewList({ label, values, empty }: { label: string; values: string[]; empty: string }) {
  return <div><h3 className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{label}</h3>{values.length > 0 ? <ul className="list-disc space-y-0.5 pl-4 text-text-secondary">{values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}</ul> : <p className="text-text-muted">{empty}</p>}</div>;
}

function PaneOverviewCard({ pane }: { pane: OrchestrationSessionOverview['panes'][number] }) {
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const openPane = () => {
    if (pane.missing) return;
    setActiveSession(pane.paneId);
    navigateToSessions();
  };
  return (
    <div className="mt-2 rounded border border-border-primary bg-surface-secondary p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><p className="truncate font-medium text-text-primary">{pane.name}</p><p className="truncate text-[10px] text-text-muted">{pane.branch || 'Branch unknown'}{pane.archived ? ' · archived' : pane.missing ? ' · missing' : ''}</p></div>
        {!pane.missing && <button type="button" onClick={openPane} className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-interactive hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive">Open Pane</button>}
      </div>
      {pane.panels.map(panel => <div key={panel.panelId} className="mt-1 flex items-center justify-between gap-2 text-[10px]"><span className="min-w-0 truncate text-text-secondary">{panel.title}</span><span className={cn('flex-shrink-0', panel.state === 'blocked' ? 'text-status-error' : panel.state === 'working' ? 'text-status-warning' : 'text-text-muted')}>{panel.missing ? 'missing' : panel.state}</span></div>)}
      {pane.git && <p className="mt-1 text-[10px] text-text-muted">{pane.git.hasUncommittedChanges ? 'Uncommitted changes' : 'Clean working tree'}{pane.git.prNumber ? ` · PR #${pane.git.prNumber}` : ''}</p>}
    </div>
  );
}

function LinkList({ links }: { links: OrchestrationSessionRecord['evidence'] }) {
  if (links.length === 0) return <p className="text-text-muted">No links recorded.</p>;
  return <ul className="mt-1 space-y-1">{links.map((link, index) => <li key={`${link.url}-${index}`}><button type="button" onClick={() => void openSessionLink(link.url)} className="inline-flex max-w-full items-center gap-1 text-left text-interactive hover:underline focus:outline-none focus:ring-2 focus:ring-interactive"><ExternalLink className="h-3 w-3 flex-shrink-0" /><span className="truncate">{link.label}</span></button>{link.provenance && <span className="ml-1 text-[10px] text-text-muted">({link.provenance})</span>}</li>)}</ul>;
}

async function openSessionLink(value: string): Promise<void> {
  if (!/^file:/i.test(value)) {
    await window.electronAPI.openExternal(value);
    return;
  }

  try {
    const url = new URL(value);
    if (url.hostname && url.hostname !== 'localhost') {
      console.error('Refusing to reveal a file link on a remote host');
      return;
    }
    let filePath = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
    if (!filePath) {
      console.error('Refusing to reveal an empty file link');
      return;
    }
    await window.electronAPI.invoke('app:showItemInFolder', filePath);
  } catch (cause) {
    console.error('Failed to reveal Session artifact:', cause);
  }
}

function splitLines(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(Boolean);
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
