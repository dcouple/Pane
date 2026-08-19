import type { Page } from '@playwright/test';
import type { CloudVmState } from '../shared/types/cloud';
import type { PaneChatAgent } from '../shared/types/paneChat';
import type { PanePermissionRequest, PanePermissionResponse } from '../shared/types/permissions';
import type {
  RemoteDaemonClientRecord,
  RemoteDaemonConfig,
  RemoteDaemonHostConfig,
  RemotePaneConnectionProfile,
  RemotePaneConnectionState,
} from '../shared/types/remoteDaemon';
import type { SubmitFeedbackRequest } from '../shared/types/feedback';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';

type MockEventValue = JsonValue | object | undefined;
type MockEventCallback = (...args: MockEventValue[]) => void;

type AnalyticsMainEvent = {
  eventName: string;
  properties?: JsonObject;
};

type ElectronApiMockOptions = {
  analyticsConsentShown?: boolean;
  analyticsIdentity?: JsonObject;
  initialConfig?: JsonObject;
  initialPreferences?: Record<string, string>;
  platform?: 'darwin' | 'linux' | 'win32';
  /** Whether main handed the title bar to the page (Window Controls Overlay). */
  windowControlsOverlayEnabled?: boolean;
  availableShells?: Array<Record<string, string>>;
  configReadDelayMs?: number;
  configGetFailures?: number;
  notificationsSupported?: boolean;
  mainAnalyticsEvents?: AnalyticsMainEvent[];
  initialProjects?: JsonObject[];
  initialSessions?: JsonObject[];
  initialPanels?: JsonObject[];
  initialUiState?: Partial<{
    expandedProjects: number[];
    expandedFolders: string[];
    sessionSortAscending: boolean;
    pinnedSectionExpanded: boolean;
    repositoriesSectionExpanded: boolean;
  }>;
  initialExecutions?: JsonObject[];
  initialCombinedDiff?: JsonObject | null;
  initialTerminalStates?: Record<string, JsonObject>;
  initialAgentUsage?: JsonObject;
  forcedAgentUsageError?: string;
  detectedBranch?: string | null;
  detectedBranchByPath?: Record<string, string | null>;
  mainRepoSessionDelayByProjectId?: Record<number, number>;
  mainRepoSessionErrorByProjectId?: Record<number, string>;
  activeProjectId?: number | null;
  paneChatAgentChangeDelayMs?: number;
  feedbackOutcome?: 'success' | 'failure';
};

export async function installElectronApiMock(page: Page, options: ElectronApiMockOptions = {}) {
  await page.addInitScript((mockOptions: ElectronApiMockOptions) => {
    if (mockOptions.notificationsSupported === false) {
      Reflect.deleteProperty(window, 'Notification');
    }
    function success(): Promise<{ success: true; data: null }>;
    function success<Value>(data: Value): Promise<{ success: true; data: Value }>;
    function success<Value>(data?: Value) {
      return Promise.resolve({ success: true, data: data ?? null });
    }
    const unsubscribe = () => undefined;
    const listeners = new Map<string, Set<MockEventCallback>>();
    const pendingPermissions: PanePermissionRequest[] = [];
    const feedbackSubmissions: SubmitFeedbackRequest[] = [];
    const openedExternalUrls: string[] = [];
    const clone = <T>(value: T): T => structuredClone(value);
    interface MockPreferences {
      [key: string]: string;
    }
    const preferences: MockPreferences = {
      analytics_consent_shown: mockOptions.analyticsConsentShown === false ? 'false' : 'true',
      ...clone(mockOptions.initialPreferences ?? {}),
    };
    const defaultAnalyticsIdentity = {
      distinctId: 'test',
      installId: 'install_test',
      identitySource: 'anonymous',
      appVersion: 'test',
      platform: 'linux',
      electronVersion: 'test',
      webAttributionPresent: false,
      isFirstLaunch: false,
      previousVersion: 'test',
    };
    let nextRemoteConnectionId = 1;
    const remoteDaemonConfig: RemoteDaemonConfig = {
      host: {
        config: {
          enabled: false,
          listenHost: '127.0.0.1',
          listenPort: 42137,
          pairingRequired: true,
          allowInsecureHttpOnLoopback: true,
        },
        clients: [],
      },
      client: {
        profiles: [],
        activeProfileId: null,
        mode: 'local',
      },
    };
    const remoteConnectionState: RemotePaneConnectionState = {
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
      lastSeenAt: null,
    };
    const remoteHostState = {
      enabled: false,
      status: 'inactive' as const,
      listenHost: null,
      listenPort: null,
      lastError: null,
      connectedClients: [],
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
    const cloudState: CloudVmState = {
      status: 'not_provisioned',
      ip: null,
      noVncUrl: null,
      provider: null,
      serverId: null,
      lastChecked: null,
      error: null,
      tunnelStatus: 'off',
      daemonStatus: 'unknown',
      daemonBaseUrl: null,
      linkedRemoteProfileId: null,
      linkedRemoteProfileLabel: null,
      remoteConnectionStatus: 'unlinked',
      preferredAccess: 'daemon',
      allowNoVncFallback: true,
    };
    const configState: JsonObject = {
      remoteDaemon: clone(remoteDaemonConfig),
      defaultOrchestratorAgent: 'claude',
      ...clone(mockOptions.initialConfig ?? {}),
    };
    const paneChatSession = {
      id: '__pane_chat_session__',
      name: 'Pane Chat',
      worktreePath: '/tmp/.pane',
      prompt: '',
      status: 'stopped',
      createdAt: new Date(0).toISOString(),
      lastActivity: new Date(0).toISOString(),
      output: [],
      jsonMessages: [],
      isRunning: false,
      permissionMode: 'ignore',
      displayOrder: 0,
      isFavorite: false,
      toolType: 'none',
      archived: false,
      isHidden: true,
    };
    const createPaneChatPanel = (agent: PaneChatAgent) => ({
      id: agent === 'claude' ? '__pane_chat_terminal__' : `__pane_chat_terminal_${agent}__`,
      sessionId: '__pane_chat_session__',
      type: 'terminal',
      title: agent === 'claude' ? 'Pane Chat' : `Pane Chat - ${agent === 'codex' ? 'Codex' : 'Cursor'}`,
      state: {
        isActive: true,
        hasBeenViewed: false,
        customState: {
          initialCommand: agent === 'claude'
            ? 'claude --dangerously-skip-permissions'
            : agent === 'codex' ? 'codex --yolo' : 'cursor-agent --force --trust',
          initialInput: agent === 'cursor'
            ? 'Read /tmp/.pane/skills/pane-chat/runpane-orchestrator.md and initialize yourself as Pane Chat.'
            : 'Use the pane-orchestrator skill and initialize yourself as Pane Chat.',
          initialInputMode: 'argument',
          initialInputSubmitStrategy: 'enter',
          agentType: agent,
          isCliPanel: true,
          isCliReady: false,
        },
      },
      metadata: {
        createdAt: new Date(0).toISOString(),
        lastActiveAt: new Date(0).toISOString(),
        position: agent === 'claude' ? 0 : agent === 'codex' ? 1 : 2,
        permanent: true,
      },
    });
    const createPaneChatState = () => {
      const agent = configState.defaultOrchestratorAgent === 'codex' || configState.defaultOrchestratorAgent === 'cursor'
        ? configState.defaultOrchestratorAgent
        : 'claude';
      return {
        session: clone(paneChatSession),
        panel: clone(createPaneChatPanel(agent)),
        agent,
        cwd: '/tmp/.pane',
        guidePath: '/tmp/.pane/skills/pane-chat/runpane-orchestrator.md',
        started: false,
      };
    };
    let mockProjects = clone(mockOptions.initialProjects ?? []);
    let mockSessions = clone(mockOptions.initialSessions ?? []);
    let mockPanels = clone(mockOptions.initialPanels ?? []);
    const uiState = {
      expandedProjects: [] satisfies number[],
      expandedFolders: [] satisfies string[],
      sessionSortAscending: true,
      pinnedSectionExpanded: true,
      repositoriesSectionExpanded: true,
      ...clone(mockOptions.initialUiState ?? {}),
    };
    let mockActiveProjectId = mockOptions.activeProjectId === undefined
      ? Number(mockProjects.find((project) => project.active === true)?.id ?? null) || null
      : mockOptions.activeProjectId;
    let cloudDisconnectError: string | null = null;
    let configGetCount = 0;
    let nextConfigUpdateError: string | null = null;
    let nextPreferenceSetError: string | null = null;
    let remainingConfigGetFailures = mockOptions.configGetFailures ?? 0;
    const configUpdates: JsonObject[] = [];
    const preferenceWrites: Array<{ key: string; value: string }> = [];
    const sessionDeleteCalls: string[] = [];
    const sessionFavoriteToggleCalls: string[] = [];
    let sessionsGetCount = 0;

    const subscribe = (channel: string, callback: MockEventCallback) => {
      const callbacks = listeners.get(channel) ?? new Set<MockEventCallback>();
      callbacks.add(callback);
      listeners.set(channel, callbacks);
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          listeners.delete(channel);
        }
      };
    };

    const emit = (channel: string, ...args: MockEventValue[]) => {
      const callbacks = listeners.get(channel);
      if (!callbacks) {
        return;
      }

      for (const callback of callbacks) {
        callback(...args);
      }
    };

    const syncRemoteDaemonConfig = () => {
      configState.remoteDaemon = clone(remoteDaemonConfig);
    };

    const setRemoteConnectionState = (updates: Partial<typeof remoteConnectionState>) => {
      Object.assign(remoteConnectionState, updates);
      emit('remote-daemon:connection-state-changed', clone(remoteConnectionState));
    };

    const setRemoteHostState = (updates: Partial<typeof remoteHostState>) => {
      Object.assign(remoteHostState, updates, { updatedAt: new Date().toISOString() });
      emit('remote-daemon:host-state-changed', clone(remoteHostState));
    };

    const namespace = <Overrides extends object>(overrides: Overrides) =>
      new Proxy(overrides, {
        get(target, prop: string | symbol) {
          if (prop in target) {
            return Object.getOwnPropertyDescriptor(target, prop)?.value;
          }
          return () => success();
        },
      });

    const events = new Proxy({}, {
      get: (_target, prop: string | symbol) => {
        if (prop === 'onPermissionRequest') {
          return (callback: MockEventCallback) => subscribe('permission:request', callback);
        }
        if (prop === 'onPermissionResolved') {
          return (callback: MockEventCallback) => subscribe('permission:resolved', callback);
        }
        if (prop === 'onRemoteDaemonResyncRequested') {
          return (callback: () => void) => subscribe('remote-daemon:resync-required', callback);
        }
        if (prop === 'onGitStatusUpdated') {
          return (callback: MockEventCallback) => subscribe('git-status-updated', callback);
        }
        if (prop === 'onSessionUpdated') {
          return (callback: MockEventCallback) => subscribe('session:updated', callback);
        }
        return () => unsubscribe;
      },
    });

    const invoke = (channel: string, key?: string, value?: string) => {
      if (channel === 'panels:checkInitialized') {
        return Promise.resolve(Boolean(key && mockOptions.initialTerminalStates?.[key]));
      }
      if (channel === 'terminal:getState') {
        return Promise.resolve(key ? clone(mockOptions.initialTerminalStates?.[key] ?? null) : null);
      }
      if (channel === 'preferences:get') {
        return success(key ? preferences[key] ?? 'true' : 'true');
      }
      if (channel === 'preferences:set') {
        if (nextPreferenceSetError) {
          const error = nextPreferenceSetError;
          nextPreferenceSetError = null;
          return Promise.resolve({ success: false, error });
        }
        if (key) {
          preferences[key] = value ?? '';
          preferenceWrites.push({ key, value: value ?? '' });
        }
        return success();
      }
      if (channel === 'preferences:get-all') {
        return success(clone(preferences));
      }
      if (channel === 'archive:get-progress') {
        return success(null);
      }
      return success();
    };

    const electronAPI = {
      invoke,
      events,
      window: {
        isFocused: () => Promise.resolve(true),
      },
      getPlatform: () => Promise.resolve(mockOptions.platform ?? 'linux'),
      windowControlsOverlayEnabled: mockOptions.windowControlsOverlayEnabled === true,
      setTitleBarOverlay: () => success(),
      getVersionInfo: () => success({
        version: 'test',
        current: 'test',
        latest: 'test',
        hasUpdate: false,
      }),
      isPackaged: () => Promise.resolve(false),
      checkForUpdates: () => success({ hasUpdate: false }),
      openExternal: (url: string) => {
        openedExternalUrls.push(url);
        // Matches preload's Promise<IPCResponse> contract; callers await this result.
        return success();
      },
      feedback: namespace({
        submit: (request: SubmitFeedbackRequest) => {
          feedbackSubmissions.push(clone(request));
          if (mockOptions.feedbackOutcome === 'failure') {
            return Promise.resolve({
              success: false,
              error: 'GitHub CLI is not authenticated.',
              data: { fallbackUrl: 'https://github.com/dcouple/Pane/issues/new?title=Prefilled' },
            });
          }
          return success({ issueUrl: 'https://github.com/dcouple/Pane/issues/9001' });
        },
      }),
      analytics: namespace({
        getIdentity: () => success(clone(mockOptions.analyticsIdentity ?? defaultAnalyticsIdentity)),
        onMainEvent: (callback: MockEventCallback) => {
          const remove = subscribe('analytics:main-event', callback);
          for (const event of mockOptions.mainAnalyticsEvents ?? []) {
            callback(clone(event));
          }
          return remove;
        },
        syncDistinctId: () => undefined,
        redeemAttribution: () => success(undefined),
      }),
      agentUsage: namespace({
        get: async (force = false) => {
          if (force && mockOptions.forcedAgentUsageError) {
            return { success: false, error: mockOptions.forcedAgentUsageError };
          }
          return success(clone(mockOptions.initialAgentUsage
            ?? {
            providers: [{
              id: 'codex',
              name: 'Codex',
              status: 'unavailable',
              plan: null,
              limits: [],
              fetchedAt: new Date(0).toISOString(),
              error: 'Codex usage is unavailable in this test',
            }],
            fetchedAt: new Date(0).toISOString(),
          }));
        },
      }),
      cloud: namespace({
        getState: () => success(clone(cloudState)),
        onStateChanged: (callback: MockEventCallback) => subscribe('cloud:state-changed', callback),
        connectWorkspace: () => {
          if (!cloudState.linkedRemoteProfileId) {
            return Promise.resolve({ success: false, error: 'Hosted cloud workspace does not have a linked remote profile' });
          }
          const profile = remoteDaemonConfig.client.profiles.find(
            (candidate) => candidate.id === cloudState.linkedRemoteProfileId,
          );
          if (!profile) {
            return Promise.resolve({ success: false, error: `Hosted cloud workspace linked profile "${cloudState.linkedRemoteProfileId}" does not exist` });
          }
          remoteDaemonConfig.client.activeProfileId = profile.id;
          remoteDaemonConfig.client.mode = 'remote';
          syncRemoteDaemonConfig();
          cloudState.linkedRemoteProfileLabel = String(profile.label);
          cloudState.remoteConnectionStatus = 'connected';
          setRemoteConnectionState({
            mode: 'remote',
            status: 'connected',
            activeProfileId: String(profile.id),
            activeProfileLabel: String(profile.label),
            activeBaseUrl: String(profile.baseUrl),
            lastError: null,
          });
          emit('cloud:state-changed', clone(cloudState));
          return success(clone(cloudState));
        },
        disconnectWorkspace: () => {
          if (cloudDisconnectError) {
            return Promise.resolve({ success: false, error: cloudDisconnectError });
          }

          remoteDaemonConfig.client.activeProfileId = null;
          remoteDaemonConfig.client.mode = 'local';
          syncRemoteDaemonConfig();
          cloudState.remoteConnectionStatus = cloudState.linkedRemoteProfileId ? 'available' : 'unlinked';
          setRemoteConnectionState({
            mode: 'local',
            status: 'local',
            activeProfileId: null,
            activeProfileLabel: null,
            activeBaseUrl: null,
            lastError: null,
          });
          emit('cloud:state-changed', clone(cloudState));
          return success(clone(cloudState));
        },
        startPolling: () => success(),
        stopPolling: () => success(),
      }),
      config: namespace({
        get: async () => {
          configGetCount += 1;
          if (mockOptions.configReadDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, mockOptions.configReadDelayMs));
          }
          if (remainingConfigGetFailures > 0) {
            remainingConfigGetFailures -= 1;
            return { success: false, error: 'Mock config read failed' };
          }
          return success(clone(configState));
        },
        update: (updates: JsonObject) => {
          if (nextConfigUpdateError) {
            const error = nextConfigUpdateError;
            nextConfigUpdateError = null;
            return Promise.resolve({ success: false, error });
          }
          Object.assign(configState, updates);
          configUpdates.push(clone(updates));
          return success(clone(configState));
        },
        getAvailableShells: () => success(clone(mockOptions.availableShells ?? [])),
        getMonospaceFonts: () => success([]),
        getSessionPreferences: () => success({}),
      }),
      folders: namespace({
        getByProject: () => success([]),
      }),
      onboarding: namespace({
        detectEnvironment: () => success({}),
        getGitHubAuthCommand: () => success({ command: '', reason: 'ready' }),
        openGitHubAuthTerminal: () => success({ command: '', reason: 'ready', copied: false, openedTerminal: false, platform: process.platform }),
        startGitHubAuthTerminal: () => success({ terminalId: 'mock-github-auth-terminal', command: '', reason: 'ready', cols: 80, rows: 18 }),
        writeGitHubAuthTerminal: () => success(),
        resizeGitHubAuthTerminal: () => success(),
        killGitHubAuthTerminal: () => success(),
        onGitHubAuthTerminalOutput: (callback: MockEventCallback) => subscribe('onboarding:github-auth-pty-output', callback),
        onGitHubAuthTerminalExit: (callback: MockEventCallback) => subscribe('onboarding:github-auth-pty-exit', callback),
        setupDefaultRepo: () => success({}),
        supportProject: () => success({}),
      }),
      paneChat: namespace({
        getOrCreate: () => success(createPaneChatState()),
        setAgent: async (agent: 'claude' | 'codex' | 'cursor') => {
          if (mockOptions.paneChatAgentChangeDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, mockOptions.paneChatAgentChangeDelayMs));
          }
          configState.defaultOrchestratorAgent = agent === 'codex' || agent === 'cursor' ? agent : 'claude';
          return success(createPaneChatState());
        },
      }),
      panels: namespace({
        getSessionPanels: (sessionId: string) => success(
          clone(mockPanels.filter((panel) => panel.sessionId === sessionId)),
        ),
        shouldAutoCreate: () => success(false),
      }),
      permissions: namespace({
        getPending: () => success([...pendingPermissions]),
        respond: (requestId: string, response: PanePermissionResponse) => {
          const index = pendingPermissions.findIndex((request) => request.id === requestId);
          if (index >= 0) {
            const [request] = pendingPermissions.splice(index, 1);
            emit('permission:resolved', { request, response });
          }
          return success();
        },
      }),
      projects: namespace({
        getAll: () => success(clone(mockProjects.map((project) => ({
          ...project,
          active: mockActiveProjectId === null
            ? false
            : project.id === mockActiveProjectId,
        })))),
        getActive: () => success(clone(
          mockProjects.find((project) => project.id === mockActiveProjectId) ?? null,
        )),
        activate: (projectId: string) => {
          mockActiveProjectId = Number(projectId);
          return success();
        },
        detectBranch: (path: string) => success(
          mockOptions.detectedBranchByPath
            && Object.prototype.hasOwnProperty.call(mockOptions.detectedBranchByPath, path)
            ? mockOptions.detectedBranchByPath[path]
            : (mockOptions.detectedBranch === undefined ? 'main' : mockOptions.detectedBranch),
        ),
        listBranches: () => success([
          { name: 'origin/main', isCurrent: false, hasWorktree: false, isRemote: true },
          { name: 'main', isCurrent: true, hasWorktree: false, isRemote: false },
        ]),
        refreshGitStatus: () => success(),
      }),
      prompts: namespace({
        getAll: () => success([]),
      }),
      ptyHost: namespace({
        ack: () => Promise.resolve(),
        onData: subscribe,
        onExit: subscribe,
      }),
      resourceMonitor: namespace({
        getSnapshot: () => success(null),
        startActive: () => success(),
        stopActive: () => success(),
      }),
      sessions: namespace({
        getOrCreateMainRepoSession: async (projectId: number) => {
          const delayMs = mockOptions.mainRepoSessionDelayByProjectId?.[projectId] ?? 0;
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          const error = mockOptions.mainRepoSessionErrorByProjectId?.[projectId];
          if (error) throw new Error(error);
          return success(clone(
            mockSessions.find((session) => session.projectId === projectId && session.isMainRepo === true) ?? null,
          ));
        },
        delete: (sessionId: string) => {
          sessionDeleteCalls.push(sessionId);
          return success();
        },
        permanentDelete: () => success(),
        permanentDeleteArchived: () => success({ deletedCount: 0 }),
        toggleFavorite: (sessionId: string) => {
          sessionFavoriteToggleCalls.push(sessionId);
          return success();
        },
        getAll: () => {
          sessionsGetCount += 1;
          return success(clone(mockSessions));
        },
        getAllWithProjects: () => success(clone(mockSessions)),
        getArchivedWithProjects: () => success([]),
        getResumable: () => success([]),
        getExecutions: () => success(clone(mockOptions.initialExecutions ?? [])),
        getCombinedDiff: () => success(clone(mockOptions.initialCombinedDiff ?? null)),
      }),
      remoteDaemon: namespace({
        getConfig: () => success(clone(remoteDaemonConfig)),
        getConnectionState: () => success(clone(remoteConnectionState)),
        getHostState: () => success(clone(remoteHostState)),
        setupHost: (input: {
          dataDirectoryMode?: 'current' | 'isolated';
          paneDir?: string;
          label?: string;
          listenPort?: number;
          preferTunnel?: 'tailscale' | 'ssh' | 'manual' | 'auto';
        } = {}) => {
          const id = `remote-${nextRemoteConnectionId++}`;
          const label = input.label ?? 'Remote host';
          const listenPort = input.listenPort ?? 42137;
          const tunnelKind = input.preferTunnel === 'ssh' || input.preferTunnel === 'manual'
            ? input.preferTunnel
            : 'tailscale';
          const token = `token-${id}`;
          const client = {
            id,
            label,
            createdAt: new Date().toISOString(),
            tokenHash: `hash-${token}`,
          };
          remoteDaemonConfig.host.config = {
            ...remoteDaemonConfig.host.config,
            enabled: true,
            listenPort,
          };
          remoteDaemonConfig.host.clients.push(client);
          syncRemoteDaemonConfig();
          setRemoteHostState({
            enabled: true,
            status: 'live',
            listenHost: remoteDaemonConfig.host.config.listenHost,
            listenPort,
            lastError: null,
          });
          return success({
            dataDirectoryMode: input.dataDirectoryMode ?? 'current',
            paneDir: input.paneDir ?? '~/.pane',
            configPath: `${input.paneDir ?? '~/.pane'}/config.json`,
            label,
            listenPort,
            channel: 'stable',
            connectionCode: 'pane-remote://mock-remote-code',
            tunnel: {
              kind: tunnelKind,
              selected: true,
              note: 'Mock remote setup',
            },
            fallbackTunnelCommands: [],
            service: {
              strategy: 'manual',
              installed: false,
              started: false,
              message: 'Mock setup',
            },
            manualDaemonCommand: 'pane --daemon-headless',
            wroteConfig: true,
          });
        },
        getInteractiveSetupCommand: () => success({
          command: 'node scripts/pane-remote-setup.js --interactive-tailscale-setup',
        }),
        createConnectionPair: (input: { label?: string; baseUrl?: string }) => {
          const id = `remote-${nextRemoteConnectionId++}`;
          const label = input.label ?? 'Remote host';
          const baseUrl = input.baseUrl ?? 'http://127.0.0.1:42137';
          const token = `token-${id}`;
          const client = {
            id,
            label,
            createdAt: new Date().toISOString(),
            tokenHash: `hash-${token}`,
          };
          const profile = {
            id,
            label,
            baseUrl,
            token,
            transport: 'http+sse',
          };
          remoteDaemonConfig.host.clients.push(client);
          remoteDaemonConfig.client.profiles.push(profile);
          syncRemoteDaemonConfig();
          return success({ client, profile, token });
        },
        updateHostConfig: (updates: Partial<RemoteDaemonHostConfig>) => {
          remoteDaemonConfig.host.config = {
            ...remoteDaemonConfig.host.config,
            ...updates,
          };
          syncRemoteDaemonConfig();
          setRemoteHostState({
            enabled: Boolean(remoteDaemonConfig.host.config.enabled),
            status: remoteDaemonConfig.host.config.enabled ? 'live' : 'inactive',
            listenHost: remoteDaemonConfig.host.config.enabled ? remoteDaemonConfig.host.config.listenHost : null,
            listenPort: remoteDaemonConfig.host.config.enabled ? remoteDaemonConfig.host.config.listenPort : null,
            lastError: null,
            connectedClients: [],
          });
          return success(clone(remoteDaemonConfig.host.config));
        },
        upsertClientRecord: (record: RemoteDaemonClientRecord) => {
          const existingIndex = remoteDaemonConfig.host.clients.findIndex((client) => client.id === record.id);
          if (existingIndex >= 0) {
            remoteDaemonConfig.host.clients[existingIndex] = record;
          } else {
            remoteDaemonConfig.host.clients.push(record);
          }
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.host.clients));
        },
        deleteClientRecord: (clientId: string) => {
          remoteDaemonConfig.host.clients = remoteDaemonConfig.host.clients.filter((client) => client.id !== clientId);
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.host.clients));
        },
        upsertConnectionProfile: (profile: RemotePaneConnectionProfile) => {
          const existingIndex = remoteDaemonConfig.client.profiles.findIndex((existing) => existing.id === profile.id);
          if (existingIndex >= 0) {
            remoteDaemonConfig.client.profiles[existingIndex] = profile;
          } else {
            remoteDaemonConfig.client.profiles.push(profile);
          }
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.client.profiles));
        },
        deleteConnectionProfile: (profileId: string) => {
          remoteDaemonConfig.client.profiles = remoteDaemonConfig.client.profiles.filter((profile) => profile.id !== profileId);
          if (remoteDaemonConfig.client.activeProfileId === profileId) {
            remoteDaemonConfig.client.activeProfileId = null;
            remoteDaemonConfig.client.mode = 'local';
            setRemoteConnectionState({
              mode: 'local',
              status: 'local',
              activeProfileId: null,
              activeProfileLabel: null,
              activeBaseUrl: null,
              lastError: null,
            });
          }
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.client));
        },
        updateClientState: (updates: { activeProfileId?: string | null; mode?: 'local' | 'remote' }) => {
          if (updates.activeProfileId !== undefined) {
            remoteDaemonConfig.client.activeProfileId = updates.activeProfileId;
          }
          if (updates.mode) {
            remoteDaemonConfig.client.mode = updates.mode;
          }

          if (remoteDaemonConfig.client.mode === 'remote' && remoteDaemonConfig.client.activeProfileId) {
            const activeProfile = remoteDaemonConfig.client.profiles.find(
              (profile) => profile.id === remoteDaemonConfig.client.activeProfileId
            );
            setRemoteConnectionState({
              mode: 'remote',
              status: activeProfile ? 'connected' : 'error',
              activeProfileId: remoteDaemonConfig.client.activeProfileId,
              activeProfileLabel: activeProfile?.label ?? null,
              activeBaseUrl: activeProfile?.baseUrl ?? null,
              lastError: activeProfile ? null : 'Missing remote profile',
            });
          } else {
            setRemoteConnectionState({
              mode: 'local',
              status: 'local',
              activeProfileId: remoteDaemonConfig.client.activeProfileId,
              activeProfileLabel: null,
              activeBaseUrl: null,
              lastError: null,
            });
          }

          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.client));
        },
        onConnectionStateChanged: (callback: MockEventCallback) =>
          subscribe('remote-daemon:connection-state-changed', callback),
        onHostStateChanged: (callback: MockEventCallback) =>
          subscribe('remote-daemon:host-state-changed', callback),
      }),
      uiState: namespace({
        getExpanded: () => success(clone(uiState)),
        saveExpanded: () => success(),
        saveExpandedProjects: (projectIds: number[]) => {
          uiState.expandedProjects = clone(projectIds);
          return success();
        },
        saveExpandedFolders: () => success(),
        saveSessionSortAscending: (ascending: boolean) => {
          uiState.sessionSortAscending = ascending;
          return success();
        },
        saveSidebarSectionExpanded: (section: 'pinned' | 'repositories', expanded: boolean) => {
          if (section === 'pinned') uiState.pinnedSectionExpanded = expanded;
          else uiState.repositoriesSectionExpanded = expanded;
          return success();
        },
      }),
    };

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: electronAPI,
    });

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        invoke,
        on: (channel: string, callback: MockEventCallback) => {
          subscribe(channel, callback);
        },
        off: () => undefined,
      },
    });

    Object.defineProperty(window, '__paneTestElectronMock', {
      configurable: true,
      value: {
        getConfig() {
          return clone(configState);
        },
        getPreferences() {
          return clone(preferences);
        },
        getConfigUpdates() {
          return clone(configUpdates);
        },
        getFeedbackSubmissions() {
          return clone(feedbackSubmissions);
        },
        getOpenedExternalUrls() {
          return clone(openedExternalUrls);
        },
        getPreferenceWrites() {
          return clone(preferenceWrites);
        },
        failNextConfigUpdate(error: string) {
          nextConfigUpdateError = error;
        },
        failNextPreferenceSet(error: string) {
          nextPreferenceSetError = error;
        },
        setConfigGetFailures(count: number) {
          remainingConfigGetFailures = count;
        },
        emitPermissionRequest(request: PanePermissionRequest) {
          pendingPermissions.push(request);
          emit('permission:request', request);
        },
        setCloudState(updates: Partial<CloudVmState>) {
          Object.assign(cloudState, updates);
          emit('cloud:state-changed', clone(cloudState));
        },
        setCloudDisconnectError(error: string | null) {
          cloudDisconnectError = error;
        },
        emitRemoteDaemonResyncRequested() {
          emit('remote-daemon:resync-required');
        },
        getConfigReadCount() {
          return configGetCount;
        },
        setSessions(sessions: JsonObject[]) {
          mockSessions = clone(sessions);
        },
        setProjects(projects: JsonObject[], activeProjectId: number | null = null) {
          mockProjects = clone(projects);
          mockActiveProjectId = activeProjectId;
        },
        setPanels(panels: JsonObject[]) {
          mockPanels = clone(panels);
        },
        emitGitStatusUpdated(sessionId: string, gitStatus: JsonObject) {
          emit('git-status-updated', { sessionId, gitStatus: clone(gitStatus) });
        },
        emitSessionUpdated(session: JsonObject) {
          emit('session:updated', clone(session));
        },
        getSessionsReadCount() {
          return sessionsGetCount;
        },
        getSessionDeleteCalls() {
          return clone(sessionDeleteCalls);
        },
        getSessionFavoriteToggleCalls() {
          return clone(sessionFavoriteToggleCalls);
        },
      },
    });
  }, options);
}
