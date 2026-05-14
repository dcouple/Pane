import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigManager } from '../services/configManager';
import {
  getPaneDaemonEventSink,
  getPaneEventSink,
  getPaneRuntime,
  getPaneWebviewContextMap,
  getPtyHostRuntime,
  getRuntimeConfigManager,
  resetPaneRuntimeForTests,
  setPaneRuntime,
  type PaneRuntime,
} from './runtime';

describe('pane runtime', () => {
  afterEach(() => {
    resetPaneRuntimeForTests();
  });

  it('throws until runtime has been initialized', () => {
    expect(() => getPaneRuntime()).toThrow('Pane runtime has not been initialized');
    expect(() => getRuntimeConfigManager()).toThrow('Pane runtime has not been initialized');
    expect(() => getPaneWebviewContextMap()).toThrow('Pane runtime has not been initialized');
  });

  it('returns the installed runtime and helper accessors', () => {
    const configManager = { source: 'test' } as unknown as ConfigManager;
    const webviewContextMap = new Map([[1, { panelId: 'panel-1', sessionId: 'session-1' }]]);
    const daemonEventSink = {
      send: () => undefined,
    };
    const runtime: PaneRuntime = {
      eventSink: {
        send: () => undefined,
      },
      daemonEventSink,
      getConfigManager: () => configManager,
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => webviewContextMap,
    };

    setPaneRuntime(runtime);

    expect(getPaneRuntime()).toBe(runtime);
    expect(getPaneEventSink()).toBe(runtime.eventSink);
    expect(getPaneDaemonEventSink()).toBe(daemonEventSink);
    expect(getRuntimeConfigManager()).toBe(configManager);
    expect(getPtyHostRuntime()).toBeNull();
    expect(getPaneWebviewContextMap()).toBe(webviewContextMap);
  });
});
