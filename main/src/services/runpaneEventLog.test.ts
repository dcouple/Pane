import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';
import { noopPaneEventSink } from '../core/eventSink';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import { RunpaneEventLog } from './runpaneEventLog';

vi.mock('./terminalPanelManager', () => ({
  terminalPanelManager: {
    getTerminalSnapshot: vi.fn(() => null),
    getLastKnownBlocker: vi.fn(() => undefined),
    isTerminalInitialized: vi.fn(() => false),
  },
}));

const panel: ToolPanel = {
  id: 'panel-1', sessionId: 'pane-1', type: 'terminal', title: 'Terminal',
  state: { isActive: true, customState: {} },
  metadata: { createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), position: 0 },
};

function install(log: RunpaneEventLog): void {
  setPaneRuntime({
    eventSink: noopPaneEventSink, daemonEventSink: noopPaneEventSink,
    getConfigManager: () => ({}) as never,
    getRunpaneEventLog: () => log,
    getPtyHostRuntime: () => null,
    getWebviewContextMap: () => new Map(),
  });
}

describe('RunpaneEventLog', () => {
  beforeEach(() => resetPaneRuntimeForTests());
  afterEach(() => resetPaneRuntimeForTests());

  it('AC4 replays strictly after a cursor in order and preserves duplicate-identifying ids', () => {
    const log = new RunpaneEventLog(5, 'epoch-a'); install(log);
    const first = log.append('panel_created', panel);
    const second = log.append('agent_active', panel);
    const third = log.append('agent_idle', panel);
    const replay = log.replaySince(first.cursor);
    expect(replay.ok && replay.events).toEqual([second, third]);
    const repeated = log.replaySince(first.cursor);
    expect(repeated.ok && repeated.events.map(event => event.id)).toEqual([second.id, third.id]);
  });

  it('AC5 returns cursor_expired with the earliest cursor when retention ages a cursor out', () => {
    const log = new RunpaneEventLog(2, 'epoch-a'); install(log);
    const aged = log.currentCursor();
    log.append('panel_created', panel); log.append('agent_active', panel); log.append('agent_idle', panel);
    expect(log.replaySince(aged)).toEqual({ ok: false, error: {
      code: 'cursor_expired', earliestCursor: 'epoch-a:2', reconcileCommand: 'runpane panels screen --panel <panel-id> --json',
    }});
  });

  it('AC6 rejects foreign pre-restart, future, and malformed cursors after runtime re-bootstrap', () => {
    const first = new RunpaneEventLog(5, 'epoch-before'); install(first);
    const stale = first.append('panel_created', panel).cursor;
    resetPaneRuntimeForTests();
    const second = new RunpaneEventLog(5, 'epoch-after'); install(second);
    expect(second.earliestCursor()).toBe('epoch-after:0');
    for (const cursor of [stale, 'epoch-after:1', 'malformed']) {
      const result = second.replaySince(cursor);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('cursor_expired');
        expect(result.error.earliestCursor).toBe('epoch-after:0');
        expect(result.error.reconcileCommand).toContain('panels screen');
      }
    }
  });
});
