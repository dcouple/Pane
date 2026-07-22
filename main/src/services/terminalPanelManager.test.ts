import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import { createFlowControlRecord, disposeFlowControlRecord, type FlowControlRecord } from '../ptyHost/flowControl';
import { TerminalStateEmulator } from './terminalStateEmulator';

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
  getGitAttributionEnv: vi.fn(() => ({})),
}));

import { TerminalPanelManager } from './terminalPanelManager';
import { panelManager } from './panelManager';

type TerminalUnderTest = {
  pty: {
    cols: number;
    rows: number;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  isPtyHost: boolean;
  panelId: string;
  sessionId: string;
  scrollbackBuffer: string;
  alternateScreenBuffer: string;
  screenEmulator?: TerminalStateEmulator;
  commandHistory: string[];
  currentCommand: string;
  lastActivity: Date;
  lastOutputAt?: Date;
  outputGeneration: number;
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
  codexAgentSessionId?: string;
};

type FlushOutputBufferAccess = {
  flushOutputBuffer(terminal: TerminalUnderTest): void;
};

type VisibilityAccess = {
  terminals: Map<string, TerminalUnderTest>;
  setVisibility(panelId: string, isVisible: boolean, viewerId?: string): void;
  clearVisibilityViewersByPrefix(prefix: string): void;
  pruneVisibilityViewersByPrefix(prefix: string, staleAfterMs: number): void;
};

type SnapshotAccess = {
  terminals: Map<string, TerminalUnderTest>;
  getTerminalSnapshot(panelId: string): ReturnType<TerminalPanelManager['getTerminalSnapshot']>;
  getTerminalState(panelId: string): ReturnType<TerminalPanelManager['getTerminalState']>;
};

type ResizeAccess = {
  terminals: Map<string, TerminalUnderTest>;
  resizeTerminal(
    panelId: string,
    cols: number,
    rows: number,
    options?: { force?: boolean },
  ): Promise<void>;
};

type InitialInputAccess = {
  terminals: Map<string, TerminalUnderTest>;
  sendInitialInputOnce(panelId: string): void;
  deliverPendingInitialInput(panelId: string): void;
  getLastOutputAt(panelId: string): string | undefined;
  getOutputGeneration(panelId: string): number;
};

type LaunchCommandAccess = {
  resolveCliLaunchCommand(panelId: string, initialCommand: string, customState: Record<string, unknown>): {
    commandToRun: string;
    customState: Record<string, unknown>;
    isCliCommand: boolean;
  };
};

function createTerminal(overrides: Partial<TerminalUnderTest> = {}): TerminalUnderTest {
  return {
    pty: {
      cols: 80,
      rows: 24,
      pause: vi.fn(),
      resume: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    },
    isPtyHost: false,
    panelId: 'panel-1',
    sessionId: 'session-1',
    scrollbackBuffer: '',
    alternateScreenBuffer: '',
    commandHistory: [],
    currentCommand: '',
    lastActivity: new Date(),
    outputGeneration: 0,
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

describe('TerminalPanelManager terminal resize', () => {
  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.useRealTimers();
  });

  it('deduplicates ordinary same-size resizes but holds an actual redraw transition', async () => {
    vi.useFakeTimers();
    const manager = new TerminalPanelManager() as unknown as ResizeAccess;
    const terminal = createTerminal({ outputBuffer: '' });
    manager.terminals.set(terminal.panelId, terminal);

    await manager.resizeTerminal(terminal.panelId, 80, 24);
    expect(terminal.pty.resize).not.toHaveBeenCalled();

    const redraw = manager.resizeTerminal(terminal.panelId, 80, 24, { force: true });
    expect(terminal.pty.resize).toHaveBeenNthCalledWith(1, 79, 24);
    expect(terminal.pty.resize).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await redraw;
    expect(terminal.pty.resize).toHaveBeenNthCalledWith(2, 80, 24);
    disposeFlowControlRecord(terminal.flowControl);
  });
});

function createConfigManagerStub(): ConfigManager {
  return {
    getUsePtyHost: () => false,
  } as ConfigManager;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalPanelManager hidden output delivery', () => {
  afterEach(() => {
    resetPaneRuntimeForTests();
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.useRealTimers();
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

  it('keeps terminal visible until the last visible viewer hides', () => {
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
      outputBuffer: '',
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true, 'local:host');
    manager.setVisibility(terminal.panelId, true, 'remote:mac');
    manager.setVisibility(terminal.panelId, false, 'remote:mac');

    expect(terminal.isVisible).toBe(true);

    manager.setVisibility(terminal.panelId, false, 'local:host');

    expect(terminal.isVisible).toBe(false);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('clears remote viewer visibility by prefix on disconnect', () => {
    const manager = new TerminalPanelManager() as unknown as VisibilityAccess;
    const terminal = createTerminal({
      isVisible: false,
      outputBuffer: '',
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true, 'local:host');
    manager.setVisibility(terminal.panelId, true, 'remote:client-1:runtime-1:viewer:a');
    manager.clearVisibilityViewersByPrefix('remote:client-1:runtime-1');

    expect(terminal.isVisible).toBe(true);

    manager.setVisibility(terminal.panelId, false, 'local:host');

    expect(terminal.isVisible).toBe(false);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('returns emulated live screen and restore state for daemon and renderer reads', async () => {
    const manager = new TerminalPanelManager() as unknown as SnapshotAccess;
    const screenEmulator = new TerminalStateEmulator(40, 5);
    screenEmulator.write('\x1b[?1049h\x1b[Hagent screen');
    await screenEmulator.waitForIdle();
    const terminal = createTerminal({
      scrollbackBuffer: 'scrollback',
      alternateScreenBuffer: 'screen',
      screenEmulator,
      isAlternateScreen: true,
      activityStatus: 'active',
      currentCommand: 'codex',
      codexAgentSessionId: 'agent-session-1',
    });
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliPanel: true,
          isCliReady: true,
          agentType: 'codex',
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    const snapshot = manager.getTerminalSnapshot(terminal.panelId);

    expect(snapshot).toMatchObject({
      initialized: true,
      scrollbackBuffer: 'scrollback',
      alternateScreenBuffer: 'screen',
      screenText: 'agent screen',
      isAlternateScreen: true,
      activityStatus: 'active',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
      agentSessionId: 'agent-session-1',
    });
    const restoreState = await manager.getTerminalState(terminal.panelId);
    expect(restoreState).toMatchObject({
      isAlternateScreen: true,
      scrollbackBuffer: 'scrollback',
    });
    expect(restoreState?.serializedBuffer).toContain('\x1b[?1049h');
    screenEmulator.dispose();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('submits Codex initial input through the composer sequence', async () => {
    vi.useFakeTimers();
    const manager = new TerminalPanelManager() as unknown as InitialInputAccess;
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          initialInput: 'Read the Pane Chat guide and initialize yourself.',
          initialInputSubmitStrategy: 'codex-ctrl-enter' as const,
          agentType: 'codex' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledWith('Read the Pane Chat guide and initialize yourself.');
    expect(terminal.pty.write).not.toHaveBeenCalledWith('\x1b[13;5u\r');

    await vi.advanceTimersByTimeAsync(500);

    expect(terminal.pty.write).toHaveBeenCalledWith('\x1b[13;5u\r');
    expect(panelManager.updatePanel).toHaveBeenCalledWith(terminal.panelId, {
      state: expect.objectContaining({
        customState: expect.objectContaining({
          initialInputSentAt: expect.any(String),
          initialInputError: undefined,
        }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('does not treat input writes as output freshness', () => {
    const manager = new TerminalPanelManager() as unknown as InitialInputAccess & TerminalPanelManager;
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);

    manager.writeToTerminal(terminal.panelId, 'typed input');

    expect(terminal.pty.write).toHaveBeenCalledWith('typed input');
    expect(manager.getLastOutputAt(terminal.panelId)).toBeUndefined();
    expect(manager.getOutputGeneration(terminal.panelId)).toBe(0);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers pending ready initial input with the panel submit strategy', async () => {
    vi.useFakeTimers();
    const manager = new TerminalPanelManager() as unknown as InitialInputAccess;
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSubmitStrategy: 'codex-ctrl-enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    manager.deliverPendingInitialInput(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenNthCalledWith(1, '/do TM-x');

    await vi.advanceTimersByTimeAsync(500);

    expect(terminal.pty.write).toHaveBeenCalledTimes(2);
    expect(terminal.pty.write).toHaveBeenNthCalledWith(2, '\x1b[13;5u\r');
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers after a premark clear when the cliReady path already skipped', async () => {
    const manager = new TerminalPanelManager() as unknown as InitialInputAccess;
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSentAt: '2026-01-01T00:02:00.000Z',
          initialInputSubmitStrategy: 'enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).not.toHaveBeenCalled();
    delete panel.state.customState.initialInputSentAt;

    manager.deliverPendingInitialInput(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenCalledWith('/do TM-x\r');
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers initial input exactly once when cliReady and explicit triggers race', async () => {
    const manager = new TerminalPanelManager() as unknown as InitialInputAccess;
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSubmitStrategy: 'enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);

    manager.sendInitialInputOnce(terminal.panelId);
    manager.deliverPendingInitialInput(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenCalledWith('/do TM-x\r');
    expect(panelManager.updatePanel).toHaveBeenCalledTimes(1);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('passes fresh Codex initial input as a startup prompt argument', () => {
    const manager = new TerminalPanelManager() as unknown as LaunchCommandAccess;

    const result = manager.resolveCliLaunchCommand('panel-1', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'Read "the guide" and initialize `Pane Chat`.',
    });

    expect(result).toMatchObject({
      commandToRun: 'codex --yolo "Read \\"the guide\\" and initialize \\`Pane Chat\\`."',
      isCliCommand: true,
      customState: {
        agentType: 'codex',
        isCliPanel: true,
        isCliReady: false,
        initialInputSentAt: expect.any(String),
        initialInputError: undefined,
      },
    });
  });

  it('escapes shell-sensitive startup prompt arguments without changing ordinary prompts', () => {
    const manager = new TerminalPanelManager() as unknown as LaunchCommandAccess;
    const unsafeCommandSubstitution = manager.resolveCliLaunchCommand('panel-1', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'BACKSLASH\\$(touch /tmp/pwned)',
    });
    const escapedShellSyntax = manager.resolveCliLaunchCommand('panel-2', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'plain $value and `cmd`',
    });
    const ordinaryPrompt = manager.resolveCliLaunchCommand('panel-3', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'Read the guide and initialize Pane Chat.',
    });

    expect(unsafeCommandSubstitution.commandToRun).toBe('codex --yolo "BACKSLASH\\\\\\$(touch /tmp/pwned)"');
    expect(unsafeCommandSubstitution.commandToRun).not.toMatch(/(^|[^\\])(?:\\\\)*\$\(/);
    expect(escapedShellSyntax.commandToRun).toBe('codex --yolo "plain \\$value and \\`cmd\\`"');
    expect(ordinaryPrompt.commandToRun).toBe('codex --yolo "Read the guide and initialize Pane Chat."');
  });

  it('passes fresh Claude slash input as a quoted startup argument', () => {
    const manager = new TerminalPanelManager() as unknown as LaunchCommandAccess;

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        initialInputMode: 'argument',
        initialInput: '/do TM-x',
      },
    );

    expect(result).toMatchObject({
      commandToRun: 'claude --dangerously-skip-permissions --session-id 11111111-1111-4111-8111-111111111111 "/do TM-x"',
      isCliCommand: true,
      customState: {
        initialInputSentAt: expect.any(String),
        initialInputError: undefined,
      },
    });
  });

  it('preserves multiline Claude input in the quoted startup argument', () => {
    const manager = new TerminalPanelManager() as unknown as LaunchCommandAccess;
    const input = 'First line\nSecond line with $value';

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        initialInputMode: 'argument',
        initialInput: input,
      },
    );

    expect(result.commandToRun).toBe(
      'claude --dangerously-skip-permissions --session-id 11111111-1111-4111-8111-111111111111 "First line\nSecond line with \\$value"',
    );
    expect(result.customState.initialInputSentAt).toEqual(expect.any(String));
  });

  it('keeps resumed Claude input composer-bound', () => {
    const manager = new TerminalPanelManager() as unknown as LaunchCommandAccess;

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        hasClaudeSessionId: true,
        agentSessionId: '22222222-2222-4222-8222-222222222222',
        initialInputMode: 'argument',
        initialInput: '/do TM-x',
      },
    );

    expect(result.commandToRun).toBe(
      'claude --resume 22222222-2222-4222-8222-222222222222 --dangerously-skip-permissions',
    );
    expect(result.customState).not.toHaveProperty('initialInputSentAt');
  });

  it('keeps Enter as the default initial input submit strategy', async () => {
    const manager = new TerminalPanelManager() as unknown as InitialInputAccess;
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Tool',
      state: {
        isActive: true,
        customState: {
          initialInput: 'hello tool',
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledWith('hello tool\r');
    disposeFlowControlRecord(terminal.flowControl);
  });
});
