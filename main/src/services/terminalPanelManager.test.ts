import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import { createFlowControlRecord, disposeFlowControlRecord, type FlowControlRecord } from '../ptyHost/flowControl';

vi.mock('@lydell/node-pty', () => ({}));

vi.mock('./panelManager', () => ({
  panelManager: {
    emitPanelEvent: vi.fn(),
    getPanel: vi.fn(),
    updatePanel: vi.fn(),
  },
}));

vi.mock('../utils/shellPath', () => ({
  getShellPath: () => '',
}));

vi.mock('../utils/shellDetector', () => ({
  ShellDetector: {
    getDefaultShell: () => ({ path: '/bin/bash', name: 'bash', args: [] }),
  },
}));

vi.mock('../utils/wslUtils', () => ({
  getWSLShellSpawn: vi.fn(),
  buildWSLENV: vi.fn(() => ''),
}));

vi.mock('../utils/attribution', () => ({
  GIT_ATTRIBUTION_ENV: {},
}));

import { TerminalPanelManager } from './terminalPanelManager';

type TerminalUnderTest = {
  pty: {
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };
  isPtyHost: boolean;
  panelId: string;
  sessionId: string;
  scrollbackBuffer: string;
  alternateScreenBuffer: string;
  commandHistory: string[];
  currentCommand: string;
  lastActivity: Date;
  wslContext: null;
  flowControl: FlowControlRecord;
  outputBuffer: string;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  isVisible: boolean;
  isAlternateScreen: boolean;
  activityStatus: 'active' | 'idle';
  idleTimer: ReturnType<typeof setTimeout> | null;
  inSyncBlock: boolean;
  codexResumeOutputBuffer: string;
};

type FlushOutputBufferAccess = {
  flushOutputBuffer(terminal: TerminalUnderTest): void;
};

type VisibilityAccess = {
  terminals: Map<string, TerminalUnderTest>;
  setVisibility(panelId: string, isVisible: boolean): void;
};

function createTerminal(overrides: Partial<TerminalUnderTest> = {}): TerminalUnderTest {
  return {
    pty: {
      pause: vi.fn(),
      resume: vi.fn(),
    },
    isPtyHost: false,
    panelId: 'panel-1',
    sessionId: 'session-1',
    scrollbackBuffer: '',
    alternateScreenBuffer: '',
    commandHistory: [],
    currentCommand: '',
    lastActivity: new Date(),
    wslContext: null,
    flowControl: createFlowControlRecord(),
    outputBuffer: 'hello from terminal',
    outputFlushTimer: null,
    isVisible: true,
    isAlternateScreen: false,
    activityStatus: 'idle',
    idleTimer: null,
    inSyncBlock: false,
    codexResumeOutputBuffer: '',
    ...overrides,
  };
}

function createConfigManagerStub(): ConfigManager {
  return {
    getUsePtyHost: () => false,
  } as ConfigManager;
}

describe('TerminalPanelManager hidden output delivery', () => {
  afterEach(() => {
    resetPaneRuntimeForTests();
  });

  it('keeps visible terminal output on the combined runtime sink', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = new TerminalPanelManager();
    const terminal = createTerminal();

    (manager as unknown as FlushOutputBufferAccess).flushOutputBuffer(terminal);

    expect(combinedSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hello from terminal',
    });
    expect(daemonSink.send).not.toHaveBeenCalled();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('sends hidden terminal output to daemon subscribers without waking the renderer sink', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = new TerminalPanelManager();
    const terminal = createTerminal({ isVisible: false });

    (manager as unknown as FlushOutputBufferAccess).flushOutputBuffer(terminal);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hello from terminal',
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('flushes pending hidden output to daemon subscribers before making a panel visible', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = new TerminalPanelManager() as unknown as VisibilityAccess;
    const terminal = createTerminal({
      isVisible: false,
      outputBuffer: 'hidden output',
      outputFlushTimer: setTimeout(() => undefined, 10_000),
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hidden output',
    });
    expect(terminal.outputBuffer).toBe('');
    expect(terminal.outputFlushTimer).toBeNull();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('flushes buffered output to daemon subscribers before hiding a visible panel', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = new TerminalPanelManager() as unknown as VisibilityAccess;
    const terminal = createTerminal({
      isVisible: true,
      outputBuffer: 'visible output',
      outputFlushTimer: setTimeout(() => undefined, 10_000),
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, false);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'visible output',
    });
    expect(terminal.outputBuffer).toBe('');
    expect(terminal.outputFlushTimer).toBeNull();
    disposeFlowControlRecord(terminal.flowControl);
  });
});
