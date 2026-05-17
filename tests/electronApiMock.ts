import type { Page } from '@playwright/test';

export async function installElectronApiMock(page: Page) {
  await page.addInitScript(() => {
    const success = (data: unknown = null) => Promise.resolve({ success: true, data });
    const unsubscribe = () => undefined;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const pendingPermissions: Array<Record<string, unknown>> = [];

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
        getState: () => success({ status: 'idle' }),
        onStateChanged: subscribe,
        startPolling: () => success(),
        stopPolling: () => success(),
      }),
      config: namespace({
        get: () => success({}),
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
      },
    });
  });
}
