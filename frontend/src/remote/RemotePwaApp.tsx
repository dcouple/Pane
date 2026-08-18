import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ToolPanel } from '../../../shared/types/panels';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus, RemotePwaAffordances } from '../../../shared/types/remoteDaemon';
import type { Session } from '../types/session';
import {
  RemoteConnectionScreen,
  type RemoteConnectionErrorKind,
} from './components/RemoteConnectionScreen';
import { RemoteCreateSessionDialog } from './components/RemoteCreateSessionDialog';
import {
  RemotePanelTabs,
  type RemoteTerminalCreateOptions,
} from './components/RemotePanelTabs';
import { getRemotePanelTabId, getRemotePanelTabPanelId } from './components/remotePanelTabIds';
import { RemoteSessionList } from './components/RemoteSessionList';
import { RemoteSidebar } from './components/RemoteSidebar';
import { RemoteStatusBar } from './components/RemoteStatusBar';
import { RemoteTerminalPanel } from './components/RemoteTerminalPanel';
import { decodeRemoteConnectionCode } from './runtime/remoteProfile';
import { RemoteRuntimeAdapter, type RemoteProjectWithSessions } from './runtime/remoteRuntimeAdapter';
import { useRemoteSessionStore } from './stores/remoteSessionStore';

const SAVED_PROFILES_KEY = 'pane.remotePwa.savedProfiles';
const EMPTY_AFFORDANCES: RemotePwaAffordances = {
  terminalShortcuts: [],
  customCommands: [],
  voiceTranscription: {
    availableModes: [],
    defaultMode: 'streaming',
    configured: {
      cleanup: false,
      recorded: false,
      streaming: false,
      fal: false,
      deepgram: false,
      openRouter: false,
    },
    modes: {
      streaming: {
        label: 'Live',
        priceLabel: '~$0.462/hr ASR + cleanup',
        latencyLabel: 'Realtime text while speaking',
        recommended: true,
      },
      recorded: {
        label: 'Batch',
        priceLabel: '~$0.084/hr full pipeline',
        latencyLabel: 'Text appears after stop',
        recommended: false,
      },
    },
  },
};

export function RemotePwaApp() {
  const [savedProfiles, setSavedProfiles] = useState<RemotePaneConnectionProfile[]>(loadSavedProfiles);
  const [adapter, setAdapter] = useState<RemoteRuntimeAdapter | null>(null);
  const [activeProfile, setActiveProfile] = useState<RemotePaneConnectionProfile | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<RemotePaneConnectionStatus>('local');
  const [lastError, setLastError] = useState<string | null>(null);
  const [connectionErrorKind, setConnectionErrorKind] = useState<RemoteConnectionErrorKind | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [affordances, setAffordances] = useState<RemotePwaAffordances>(EMPTY_AFFORDANCES);
  const [affordancesLoading, setAffordancesLoading] = useState(false);
  const [sidebarActionSessionId, setSidebarActionSessionId] = useState<string | null>(null);
  const [createSessionProject, setCreateSessionProject] = useState<RemoteProjectWithSessions | null>(null);
  const [mountedTerminalPanelIds, setMountedTerminalPanelIds] = useState<string[]>([]);
  const sidebarOpenerRef = useRef<HTMLElement | null>(null);
  const createSessionOpenerRef = useRef<HTMLElement | null>(null);

  const openSidebar = useCallback(() => {
    sidebarOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(true);
  }, []);

  const openCreateSession = useCallback((project: RemoteProjectWithSessions) => {
    createSessionOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCreateSessionProject(project);
  }, []);

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
  const selectedPanel = selectedPanels.find(panel => panel.id === selectedPanelId) ?? selectedPanels[0] ?? null;

  useEffect(() => {
    if (!selectedPanel || selectedPanel.type !== 'terminal') return;
    setMountedTerminalPanelIds(previous => previous.includes(selectedPanel.id)
      ? previous
      : [...previous, selectedPanel.id]);
  }, [selectedPanel]);

  useEffect(() => {
    const currentPanelIds = new Set(terminalPanels.map(panel => panel.id));
    setMountedTerminalPanelIds(previous => previous.filter(panelId => currentPanelIds.has(panelId)));
  }, [terminalPanels]);

  const refreshProjects = useCallback(async (runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return null;
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
      return nextProjects;
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to load remote panes');
      return null;
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
      setSelectedPanel(activePanel?.id ?? panels[0]?.id ?? null);
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
    setConnectionErrorKind(null);

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
      setConnectionErrorKind('connection');
      throw error;
    }
  }, [loadAffordances, refreshProjects]);

  const connectCode = useCallback(async (code: string) => {
    setLastError(null);
    setConnectionErrorKind(null);
    let profile: RemotePaneConnectionProfile;
    try {
      profile = decodeRemoteConnectionCode(code);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Invalid remote Pane connection code');
      setConnectionErrorKind('connection-code');
      throw error;
    }

    forgetProfilesForBaseUrl(profile.baseUrl, setSavedProfiles);
    await connectProfile(profile);
  }, [connectProfile]);

  const disconnect = useCallback(() => {
    adapter?.disconnect();
    setAdapter(null);
    setActiveProfile(null);
    setConnectionStatus('local');
    setLastError(null);
    setConnectionErrorKind(null);
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

  const toggleRemotePinnedSession = useCallback(async (sessionId: string) => {
    if (!adapter || sidebarActionSessionId) return;
    setSidebarActionSessionId(sessionId);
    try {
      await adapter.toggleFavorite(sessionId);
      await refreshProjects(adapter);
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to update pinned pane');
    } finally {
      setSidebarActionSessionId(null);
    }
  }, [adapter, refreshProjects, sidebarActionSessionId]);

  const archiveRemoteSession = useCallback(async (sessionId: string) => {
    if (!adapter || sidebarActionSessionId) return;
    const sessionName = findSessionName(projects, sessionId) ?? 'this pane';
    if (!window.confirm(`Archive pane "${sessionName}"?`)) {
      return;
    }

    setSidebarActionSessionId(sessionId);
    try {
      await adapter.archiveSession(sessionId);
      const nextProjects = await refreshProjects(adapter);
      if (selectedSessionId === sessionId && nextProjects) {
        selectSession(findFirstSessionId(nextProjects));
      }
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to archive pane');
    } finally {
      setSidebarActionSessionId(null);
    }
  }, [adapter, projects, refreshProjects, selectSession, selectedSessionId, sidebarActionSessionId]);

  const handleRemoteSessionCreated = useCallback(async (projectId: number, sessionName: string) => {
    if (!adapter) return;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const nextProjects = await refreshProjects(adapter);
      const createdSessionId = nextProjects ? findSessionIdByName(nextProjects, projectId, sessionName) : null;
      if (createdSessionId) {
        selectSession(createdSessionId);
        setSidebarOpen(false);
        return;
      }
      await delay(500);
    }

    setSidebarOpen(false);
  }, [adapter, refreshProjects, selectSession]);

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
        // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
        const panel = event.args[0] as ToolPanel | undefined;
        if (panel?.id && panel.sessionId) {
          upsertPanel(panel);
        }
        return;
      }

      if (event.channel === 'panel:deleted') {
        // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
        const payload = event.args[0] as { panelId?: string; sessionId?: string } | undefined;
        if (payload?.panelId && payload.sessionId) {
          removePanel(payload.sessionId, payload.panelId);
        }
        return;
      }

      if (event.channel === 'panel:activeChanged') {
        // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
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
        errorKind={connectionErrorKind}
        onConnectCode={connectCode}
        onConnectProfile={connectProfile}
        onForgetProfile={forgetProfile}
      />
    );
  }

  return (
    <div className="flex h-dvh min-h-dvh w-full overflow-hidden bg-bg-primary text-text-primary">
      <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 md:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => {
                if (document.activeElement?.closest('[aria-modal="true"]')) return;
                if (sidebarOpenerRef.current?.isConnected) sidebarOpenerRef.current.focus();
              });
            }}
            className="fixed inset-y-0 left-0 z-50 w-[min(22rem,calc(100vw-2rem))] max-w-full shadow-2xl outline-none md:hidden"
          >
            <Dialog.Title className="sr-only">Remote panes</Dialog.Title>
            <RemoteSidebar
              projects={projects}
              selectedSessionId={selectedSessionId}
              loading={loading}
              actionSessionId={sidebarActionSessionId}
              onSelectSession={selectRemoteSession}
              onTogglePinned={toggleRemotePinnedSession}
              onArchiveSession={archiveRemoteSession}
              onCreateSession={(project) => {
                setSidebarOpen(false);
                openCreateSession(project);
              }}
              onRefresh={() => { void refreshProjects(adapter); }}
              onClose={() => setSidebarOpen(false)}
              className="flex h-full w-full shadow-2xl"
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <RemoteSidebar
        projects={projects}
        selectedSessionId={selectedSessionId}
        loading={loading}
        actionSessionId={sidebarActionSessionId}
        onSelectSession={selectRemoteSession}
        onTogglePinned={toggleRemotePinnedSession}
        onArchiveSession={archiveRemoteSession}
        onCreateSession={openCreateSession}
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
          onOpenSidebar={openSidebar}
        />

        <RemotePanelTabs
          panels={selectedPanels}
          selectedPanelId={selectedPanel?.id ?? null}
          creating={creatingTerminal}
          customCommands={affordances.customCommands}
          onSelectPanel={selectPanel}
          onCreateTerminal={createTerminal}
        />

        <RemoteSessionList
          session={selectedSession}
          panels={selectedPanels}
          onCreateTerminal={createTerminal}
        />

        {selectedSession && terminalPanels
          .filter(panel => panel.id === selectedPanel?.id || mountedTerminalPanelIds.includes(panel.id))
          .map(panel => {
            const selected = panel.id === selectedPanel?.id;
            return (
              <div
                key={panel.id}
                id={getRemotePanelTabPanelId(panel.id)}
                role="tabpanel"
                aria-labelledby={getRemotePanelTabId(panel.id)}
                hidden={!selected}
                tabIndex={0}
                className={selected ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : undefined}
              >
                <RemoteTerminalPanel
                  adapter={adapter}
                  panel={panel}
                  sessionId={selectedSession.id}
                  connectionStatus={connectionStatus}
                  shortcuts={affordances.terminalShortcuts}
                  shortcutsLoading={affordancesLoading}
                  voiceTranscription={affordances.voiceTranscription}
                  onRefreshShortcuts={() => { void loadAffordances(adapter); }}
                />
              </div>
            );
          })}

        {selectedSession && selectedPanel && selectedPanel.type !== 'terminal' && (
          <div
            id={getRemotePanelTabPanelId(selectedPanel.id)}
            role="tabpanel"
            aria-labelledby={getRemotePanelTabId(selectedPanel.id)}
            tabIndex={0}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <UnsupportedPanel session={selectedSession} panel={selectedPanel} />
          </div>
        )}
      </section>

      {createSessionProject && (
        <RemoteCreateSessionDialog
          adapter={adapter}
          project={createSessionProject}
          restoreFocusRef={createSessionOpenerRef}
          fallbackFocusRef={sidebarOpenerRef}
          onClose={() => setCreateSessionProject(null)}
          onCreated={(sessionName) => handleRemoteSessionCreated(createSessionProject.id, sessionName)}
        />
      )}
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

function findSessionName(projects: Array<{ sessions?: Session[] }>, sessionId: string): string | null {
  for (const project of projects) {
    const session = project.sessions?.find(candidate => candidate.id === sessionId);
    if (session) {
      return session.name || 'Untitled';
    }
  }
  return null;
}

function findSessionIdByName(projects: Array<{ id?: number; sessions?: Session[] }>, projectId: number, sessionName: string): string | null {
  const project = projects.find(candidate => candidate.id === projectId);
  const session = project?.sessions?.find(candidate => candidate.name === sessionName);
  return session?.id ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
