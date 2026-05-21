import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolPanel } from '../../../shared/types/panels';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus, RemotePwaAffordances } from '../../../shared/types/remoteDaemon';
import type { Session } from '../types/session';
import { RemoteConnectionScreen } from './components/RemoteConnectionScreen';
import { RemotePanelTabs, type RemoteTerminalCreateOptions } from './components/RemotePanelTabs';
import { RemoteSessionList } from './components/RemoteSessionList';
import { RemoteSidebar } from './components/RemoteSidebar';
import { RemoteStatusBar } from './components/RemoteStatusBar';
import { RemoteTerminalPanel } from './components/RemoteTerminalPanel';
import { decodeRemoteConnectionCode } from './runtime/remoteProfile';
import { RemoteRuntimeAdapter } from './runtime/remoteRuntimeAdapter';
import { useRemoteSessionStore } from './stores/remoteSessionStore';

const SAVED_PROFILES_KEY = 'pane.remotePwa.savedProfiles';
const EMPTY_AFFORDANCES: RemotePwaAffordances = {
  terminalShortcuts: [],
  customCommands: [],
};

export function RemotePwaApp() {
  const [savedProfiles, setSavedProfiles] = useState<RemotePaneConnectionProfile[]>(loadSavedProfiles);
  const [adapter, setAdapter] = useState<RemoteRuntimeAdapter | null>(null);
  const [activeProfile, setActiveProfile] = useState<RemotePaneConnectionProfile | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<RemotePaneConnectionStatus>('local');
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [affordances, setAffordances] = useState<RemotePwaAffordances>(EMPTY_AFFORDANCES);
  const [affordancesLoading, setAffordancesLoading] = useState(false);

  const projects = useRemoteSessionStore(state => state.projects);
  const selectedSessionId = useRemoteSessionStore(state => state.selectedSessionId);
  const selectedPanelId = useRemoteSessionStore(state => state.selectedPanelId);
  const panelsBySessionId = useRemoteSessionStore(state => state.panelsBySessionId);
  const setProjects = useRemoteSessionStore(state => state.setProjects);
  const selectSession = useRemoteSessionStore(state => state.selectSession);
  const setPanels = useRemoteSessionStore(state => state.setPanels);
  const setSelectedPanel = useRemoteSessionStore(state => state.setSelectedPanel);
  const upsertPanel = useRemoteSessionStore(state => state.upsertPanel);
  const removePanel = useRemoteSessionStore(state => state.removePanel);

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return null;
    for (const project of projects) {
      const session = project.sessions?.find(candidate => candidate.id === selectedSessionId);
      if (session) return session;
    }
    return null;
  }, [projects, selectedSessionId]);

  const selectedPanels = selectedSessionId ? panelsBySessionId[selectedSessionId] ?? [] : [];
  const terminalPanels = useMemo(
    () => selectedPanels.filter(panel => panel.type === 'terminal'),
    [selectedPanels],
  );
  const selectedPanel = terminalPanels.find(panel => panel.id === selectedPanelId) ?? terminalPanels[0] ?? null;

  const refreshProjects = useCallback(async (runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return;
    setLoading(true);
    try {
      const nextProjects = await runtime.getProjectsWithSessions();
      setProjects(nextProjects);
      const hasSelectedSession = Boolean(selectedSessionId && nextProjects.some(project =>
        project.sessions?.some(session => session.id === selectedSessionId),
      ));
      if (!hasSelectedSession) {
        selectSession(findFirstSessionId(nextProjects));
      }
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to load remote panes');
    } finally {
      setLoading(false);
    }
  }, [adapter, selectSession, selectedSessionId, setProjects]);

  const loadPanels = useCallback(async (sessionId: string, runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return;
    try {
      const [panels, activePanel] = await Promise.all([
        runtime.getPanels(sessionId),
        runtime.getActivePanel(sessionId).catch(() => null),
      ]);
      setPanels(sessionId, panels);
      const activeTerminalPanel = activePanel?.type === 'terminal' ? activePanel : null;
      const firstTerminalPanel = panels.find(panel => panel.type === 'terminal') ?? null;
      setSelectedPanel(activeTerminalPanel?.id ?? firstTerminalPanel?.id ?? null);
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to load remote panels');
    }
  }, [adapter, setPanels, setSelectedPanel]);

  const loadAffordances = useCallback(async (runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return;
    setAffordancesLoading(true);
    try {
      setAffordances(await runtime.getPwaAffordances());
    } catch {
      setAffordances(EMPTY_AFFORDANCES);
    } finally {
      setAffordancesLoading(false);
    }
  }, [adapter]);

  const connectProfile = useCallback(async (profile: RemotePaneConnectionProfile) => {
    const runtime = new RemoteRuntimeAdapter(profile);
    setConnectionStatus('connecting');
    setLastError(null);

    try {
      await runtime.connect();
      setAdapter(runtime);
      setActiveProfile(profile);
      saveProfile(profile, setSavedProfiles);
      await refreshProjects(runtime);
      await loadAffordances(runtime);
    } catch (error) {
      runtime.disconnect();
      setAdapter(null);
      setActiveProfile(null);
      setConnectionStatus('local');
      setLastError(error instanceof Error ? error.message : 'Failed to connect to remote Pane');
      throw error;
    }
  }, [loadAffordances, refreshProjects]);

  const connectCode = useCallback(async (code: string) => {
    const profile = decodeRemoteConnectionCode(code);
    forgetProfilesForBaseUrl(profile.baseUrl, setSavedProfiles);
    await connectProfile(profile);
  }, [connectProfile]);

  const disconnect = useCallback(() => {
    adapter?.disconnect();
    setAdapter(null);
    setActiveProfile(null);
    setConnectionStatus('local');
    setLastError(null);
    setLastSeenAt(null);
    setAffordances(EMPTY_AFFORDANCES);
    setAffordancesLoading(false);
    setProjects([]);
    selectSession(null);
  }, [adapter, selectSession, setProjects]);

  const forgetProfile = useCallback((profileId: string) => {
    setSavedProfiles(previous => {
      const next = previous.filter(profile => profile.id !== profileId);
      window.localStorage.setItem(SAVED_PROFILES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const createTerminal = useCallback(async (options?: RemoteTerminalCreateOptions) => {
    if (!adapter || !selectedSessionId) return;
    setCreatingTerminal(true);
    try {
      const panel = await adapter.createTerminalPanel(selectedSessionId, options);
      upsertPanel(panel);
      setSelectedPanel(panel.id);
      await adapter.setActivePanel(selectedSessionId, panel.id);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to create terminal');
    } finally {
      setCreatingTerminal(false);
    }
  }, [adapter, selectedSessionId, setSelectedPanel, upsertPanel]);

  const selectRemoteSession = useCallback((sessionId: string) => {
    selectSession(sessionId);
    setSidebarOpen(false);
  }, [selectSession]);

  const selectPanel = useCallback((panelId: string) => {
    if (!adapter || !selectedSessionId) return;
    setSelectedPanel(panelId);
    void adapter.setActivePanel(selectedSessionId, panelId).catch(error => {
      setLastError(error instanceof Error ? error.message : 'Failed to set active panel');
    });
  }, [adapter, selectedSessionId, setSelectedPanel]);

  useEffect(() => {
    if (!adapter) return;
    return adapter.onStatus(state => {
      setConnectionStatus(state.status);
      setLastError(state.lastError);
      setLastSeenAt(state.lastSeenAt);
    });
  }, [adapter]);

  useEffect(() => {
    if (!adapter) return;
    return adapter.onEvent(event => {
      if (event.channel === 'panel:created' || event.channel === 'panel:updated') {
        const panel = event.args[0] as ToolPanel | undefined;
        if (panel?.id && panel.sessionId) {
          upsertPanel(panel);
        }
        return;
      }

      if (event.channel === 'panel:deleted') {
        const payload = event.args[0] as { panelId?: string; sessionId?: string } | undefined;
        if (payload?.panelId && payload.sessionId) {
          removePanel(payload.sessionId, payload.panelId);
        }
        return;
      }

      if (event.channel === 'panel:activeChanged') {
        const payload = event.args[0] as { sessionId?: string; panelId?: string } | undefined;
        if (payload?.sessionId === selectedSessionId && payload.panelId) {
          setSelectedPanel(payload.panelId);
        }
        return;
      }

      if (event.channel.startsWith('session:') || event.channel.startsWith('project:')) {
        void refreshProjects(adapter);
      }
    });
  }, [adapter, refreshProjects, removePanel, selectedSessionId, setSelectedPanel, upsertPanel]);

  useEffect(() => {
    if (!selectedSessionId || !adapter) return;
    void loadPanels(selectedSessionId, adapter);
  }, [adapter, loadPanels, selectedSessionId]);

  if (!adapter || !activeProfile) {
    return (
      <RemoteConnectionScreen
        savedProfiles={savedProfiles}
        error={lastError}
        onConnectCode={connectCode}
        onConnectProfile={connectProfile}
        onForgetProfile={forgetProfile}
      />
    );
  }

  return (
    <div className="flex h-dvh min-h-dvh w-full overflow-hidden bg-bg-primary text-text-primary">
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Remote panes">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label="Close remote panes"
            onClick={() => setSidebarOpen(false)}
          />
          <RemoteSidebar
            projects={projects}
            selectedSessionId={selectedSessionId}
            loading={loading}
            onSelectSession={selectRemoteSession}
            onRefresh={() => { void refreshProjects(adapter); }}
            onClose={() => setSidebarOpen(false)}
            className="absolute inset-y-0 left-0 flex w-[min(22rem,calc(100vw-2rem))] max-w-full shadow-2xl"
          />
        </div>
      )}

      <RemoteSidebar
        projects={projects}
        selectedSessionId={selectedSessionId}
        loading={loading}
        onSelectSession={selectRemoteSession}
        onRefresh={() => { void refreshProjects(adapter); }}
        className="hidden w-80 shrink-0 md:flex"
      />
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <RemoteStatusBar
          profile={activeProfile}
          status={connectionStatus}
          lastError={lastError}
          lastSeenAt={lastSeenAt}
          onDisconnect={disconnect}
          onOpenSidebar={() => setSidebarOpen(true)}
        />

        <RemotePanelTabs
          panels={terminalPanels}
          selectedPanelId={selectedPanel?.id ?? null}
          creating={creatingTerminal}
          customCommands={affordances.customCommands}
          onSelectPanel={selectPanel}
          onCreateTerminal={createTerminal}
        />

        <RemoteSessionList
          session={selectedSession}
          panels={terminalPanels}
          onCreateTerminal={createTerminal}
        />

        {selectedSession && selectedPanel?.type === 'terminal' && (
          <RemoteTerminalPanel
            adapter={adapter}
            panel={selectedPanel}
            sessionId={selectedSession.id}
            connectionStatus={connectionStatus}
            shortcuts={affordances.terminalShortcuts}
            shortcutsLoading={affordancesLoading}
            onRefreshShortcuts={() => { void loadAffordances(adapter); }}
          />
        )}

        {selectedSession && selectedPanel && selectedPanel.type !== 'terminal' && (
          <UnsupportedPanel session={selectedSession} panel={selectedPanel} />
        )}
      </section>
    </div>
  );
}

function UnsupportedPanel({ session, panel }: { session: Session; panel: ToolPanel }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-bg-primary p-6">
      <div className="max-w-md rounded-lg border border-border-primary bg-surface-primary p-6">
        <p className="text-sm font-semibold text-text-primary">{panel.title}</p>
        <p className="mt-2 text-sm text-text-secondary">
          {panel.type} panels are visible in desktop Pane. Remote Pane PWA currently supports terminal panels for {session.name}.
        </p>
      </div>
    </div>
  );
}

function findFirstSessionId(projects: Array<{ sessions?: Session[] }>): string | null {
  for (const project of projects) {
    const session = project.sessions?.[0];
    if (session) {
      return session.id;
    }
  }
  return null;
}

function loadSavedProfiles(): RemotePaneConnectionProfile[] {
  try {
    const raw = window.localStorage.getItem(SAVED_PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProfile(
  profile: RemotePaneConnectionProfile,
  setSavedProfiles: (updater: (profiles: RemotePaneConnectionProfile[]) => RemotePaneConnectionProfile[]) => void,
): void {
  setSavedProfiles(previous => {
    const next = [profile, ...previous.filter(candidate => (
      candidate.id !== profile.id && candidate.baseUrl !== profile.baseUrl
    ))];
    window.localStorage.setItem(SAVED_PROFILES_KEY, JSON.stringify(next));
    return next;
  });
}

function forgetProfilesForBaseUrl(
  baseUrl: string,
  setSavedProfiles: (updater: (profiles: RemotePaneConnectionProfile[]) => RemotePaneConnectionProfile[]) => void,
): void {
  setSavedProfiles(previous => {
    const next = previous.filter(profile => profile.baseUrl !== baseUrl);
    if (next.length !== previous.length) {
      window.localStorage.setItem(SAVED_PROFILES_KEY, JSON.stringify(next));
    }
    return next;
  });
}
