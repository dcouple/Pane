import type { Page } from '@playwright/test';

export async function installElectronApiMock(page: Page) {
  await page.addInitScript(() => {
    const success = (data: unknown = null) => Promise.resolve({ success: true, data });
    const unsubscribe = () => undefined;
    const subscribe = () => unsubscribe;

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
      get: () => subscribe,
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
        on: subscribe,
        off: () => undefined,
      },
    });
  });
}
