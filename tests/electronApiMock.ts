import type { Page } from '@playwright/test';

export async function installElectronApiMock(page: Page) {
  await page.addInitScript(() => {
    const success = (data: unknown = null) => Promise.resolve({ success: true, data });
    const unsubscribe = () => undefined;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const pendingPermissions: Array<Record<string, unknown>> = [];
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    let nextRemoteConnectionId = 1;
    const remoteDaemonConfig = {
      host: {
        config: {
          enabled: false,
          listenHost: '127.0.0.1',
          listenPort: 42137,
          pairingRequired: true,
          allowInsecureHttpOnLoopback: true,
        },
        clients: [] as Array<Record<string, unknown>>,
      },
      client: {
        profiles: [] as Array<Record<string, unknown>>,
        activeProfileId: null as string | null,
        mode: 'local' as 'local' | 'remote',
      },
    };
    const remoteConnectionState = {
      mode: 'local' as 'local' | 'remote',
      status: 'local' as 'local' | 'connecting' | 'connected' | 'reconnecting' | 'error',
      activeProfileId: null as string | null,
      activeProfileLabel: null as string | null,
      activeBaseUrl: null as string | null,
      lastError: null as string | null,
    };
    const cloudState = {
      status: 'not_provisioned' as const,
      ip: null as string | null,
      noVncUrl: null as string | null,
      provider: null as 'gcp' | null,
      serverId: null as string | null,
      lastChecked: null as string | null,
      error: null as string | null,
      tunnelStatus: 'off' as const,
      daemonStatus: 'unknown' as const,
      daemonBaseUrl: null as string | null,
      linkedRemoteProfileId: null as string | null,
      linkedRemoteProfileLabel: null as string | null,
      remoteConnectionStatus: 'unlinked' as const,
      preferredAccess: 'daemon' as const,
      allowNoVncFallback: true,
    };
    const configState: Record<string, unknown> = {
      remoteDaemon: clone(remoteDaemonConfig),
    };
    let cloudDisconnectError: string | null = null;
    let configGetCount = 0;

    const subscribe = (channel: string, callback: (...args: unknown[]) => void) => {
      const callbacks = listeners.get(channel) ?? new Set<(...args: unknown[]) => void>();
      callbacks.add(callback);
      listeners.set(channel, callbacks);
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          listeners.delete(channel);
        }
      };
    };

    const emit = (channel: string, ...args: unknown[]) => {
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

    const namespace = (overrides: Record<string, unknown> = {}) =>
      new Proxy(overrides, {
        get(target, prop: string | symbol) {
          if (prop in target) {
            return target[prop as keyof typeof target];
          }
          return () => success();
        },
      });

    const events = new Proxy({}, {
      get: (_target, prop: string | symbol) => {
        if (prop === 'onPermissionRequest') {
          return (callback: (request: unknown) => void) => subscribe('permission:request', callback);
        }
        if (prop === 'onPermissionResolved') {
          return (callback: (event: unknown) => void) => subscribe('permission:resolved', callback);
        }
        if (prop === 'onRemoteDaemonResyncRequested') {
          return (callback: () => void) => subscribe('remote-daemon:resync-required', callback);
        }
        return () => unsubscribe;
      },
    });

    const invoke = (channel: string) => {
      if (channel === 'preferences:get') {
        return success('true');
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
      getPlatform: () => Promise.resolve('linux'),
      getVersionInfo: () => success({
        version: 'test',
        current: 'test',
        latest: 'test',
        hasUpdate: false,
      }),
      isPackaged: () => Promise.resolve(false),
      checkForUpdates: () => success({ hasUpdate: false }),
      openExternal: () => undefined,
      analytics: namespace({
        getIdentity: () => success({ distinctId: 'test', hasConsent: false }),
        onMainEvent: subscribe,
        syncDistinctId: () => undefined,
      }),
      cloud: namespace({
        getState: () => success(clone(cloudState)),
        onStateChanged: (callback: (state: unknown) => void) => subscribe('cloud:state-changed', callback),
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
        get: () => {
          configGetCount += 1;
          return success(clone(configState));
        },
        update: (updates: Record<string, unknown>) => {
          Object.assign(configState, updates);
          return success();
        },
        getAvailableShells: () => success([]),
        getMonospaceFonts: () => success([]),
        getSessionPreferences: () => success({}),
      }),
      folders: namespace({
        getByProject: () => success([]),
      }),
      onboarding: namespace({
        detectEnvironment: () => success({}),
        setupDefaultRepo: () => success({}),
        starRepo: () => success({}),
      }),
      panels: namespace({
        getSessionPanels: () => success([]),
        shouldAutoCreate: () => success(false),
      }),
      permissions: namespace({
        getPending: () => success([...pendingPermissions]),
        respond: (requestId: string, response: Record<string, unknown>) => {
          const index = pendingPermissions.findIndex((request) => request.id === requestId);
          if (index >= 0) {
            const [request] = pendingPermissions.splice(index, 1);
            emit('permission:resolved', { request, response });
          }
          return success();
        },
      }),
      projects: namespace({
        getAll: () => success([]),
        getActive: () => success(null),
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
        getAll: () => success([]),
        getAllWithProjects: () => success([]),
        getArchivedWithProjects: () => success([]),
        getResumable: () => success([]),
      }),
      remoteDaemon: namespace({
        getConfig: () => success(clone(remoteDaemonConfig)),
        getConnectionState: () => success(clone(remoteConnectionState)),
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
        updateHostConfig: (updates: Record<string, unknown>) => {
          remoteDaemonConfig.host.config = {
            ...remoteDaemonConfig.host.config,
            ...updates,
          };
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.host.config));
        },
        upsertClientRecord: (record: Record<string, unknown>) => {
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
        upsertConnectionProfile: (profile: Record<string, unknown>) => {
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
        onConnectionStateChanged: (callback: (state: unknown) => void) =>
          subscribe('remote-daemon:connection-state-changed', callback),
      }),
      uiState: namespace({
        getExpanded: () => success([]),
        saveSessionSortAscending: () => success(),
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
        on: (channel: string, callback: (...args: unknown[]) => void) => {
          subscribe(channel, callback);
        },
        off: () => undefined,
      },
    });

    Object.defineProperty(window, '__paneTestElectronMock', {
      configurable: true,
      value: {
        emitPermissionRequest(request: Record<string, unknown>) {
          pendingPermissions.push(request);
          emit('permission:request', request);
        },
        setCloudState(updates: Record<string, unknown>) {
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
      },
    });
  });
}
