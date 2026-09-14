import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import { resetPaneRuntimeForTests, setPaneRuntime, type PtyHostRuntime, type PtyHandleLike } from '../core/runtime';
import { createFlowControlRecord, disposeFlowControlRecord, type FlowControlRecord } from '../ptyHost/flowControl';
import { TerminalStateEmulator } from './terminalStateEmulator';
import type { TerminalPanelState } from '../../../shared/types/panels';

import { TerminalPanelManager } from './terminalPanelManager';
import { panelManager } from '../test/panelManagerFake';
import { ShellDetector } from '../utils/shellDetector';
import type { ToolPanel } from '../../../shared/types/panels';

vi.spyOn(panelManager, 'emitPanelEvent');
vi.spyOn(panelManager, 'getPanel');
vi.spyOn(panelManager, 'updatePanel');

type TerminalUnderTest = {
  pty: {
    cols: number;
    rows: number;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
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
  inSyncBlock: boolean;
  agentType?: 'claude' | 'codex' | 'cursor';
  agentSessionScrapeBuffer: string;
  capturedAgentSessionId?: string;
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
  resolveCliLaunchCommand(panelId: string, initialCommand: string, customState: TerminalPanelState, shellType?: string): {
    commandToRun: string;
    customState: TerminalPanelState;
    isCliCommand: boolean;
  };
};

type AgentSessionCaptureAccess = {
  terminals: Map<string, TerminalUnderTest>;
  captureAgentSessionId(terminal: TerminalUnderTest, output: string): void;
  saveTerminalState(panelId: string): Promise<void>;
};

type DestroyAllAccess = {
  terminals: Map<string, TerminalUnderTest>;
  destroyAllTerminals(): void;
  flushOutputBuffer(terminal: TerminalUnderTest): void;
};

type ShellPromptSchedulerAccess = {
  scheduleAfterShellPrompt(ptyProcess: TerminalUnderTest['pty'] & {
    onData(listener: (data: string) => void): { dispose(): void };
  }, callback: () => void): void;
};

function testAccess<Access>(manager: TerminalPanelManager): Access {
  // SAFETY: Each access type above mirrors the exact private members exercised
  // by its tests; this helper keeps that deliberate test-only seam in one place.
  return manager as Access;
}

function partialMock<Contract>(implementation: Partial<Contract>): Contract {
  // SAFETY: Each test stub implements every ConfigManager member reached by
  // the scenario; an unexpected call fails immediately instead of escaping.
  return implementation as Contract;
}

function createTerminal(overrides: Partial<TerminalUnderTest> = {}): TerminalUnderTest {
  return {
    pty: {
      cols: 80,
      rows: 24,
      pause: vi.fn(),
      resume: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
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
    inSyncBlock: false,
    agentSessionScrapeBuffer: '',
    ...overrides,
  };
}

describe('session-owned agent terminals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    resetPaneRuntimeForTests();
  });

  function fixture() {
    vi.useFakeTimers();
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(code: number | null, signal: number | null) => void>();
    const handle: PtyHandleLike = {
      id: 'pty-1', pid: 123,
      onData: listener => { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
      onExit: listener => { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
      write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined), pause: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined),
    };
    const spawn = vi.fn<PtyHostRuntime['spawn']>().mockResolvedValue({ ptyId: handle.id, pid: handle.pid });
    const supervisor: PtyHostRuntime = {
      spawn, getHandle: () => handle, write: handle.write, resize: vi.fn().mockResolvedValue(undefined),
      kill: handle.kill, ack: vi.fn().mockResolvedValue(undefined), pause: handle.pause, resume: handle.resume,
      postDataToRenderers: vi.fn(),
    };
    setPaneRuntime({
      eventSink: { send: vi.fn() },
      getConfigManager: () => partialMock<ConfigManager>({ getConfig: () => ({}), getPreferredShell: () => undefined, getUsePtyHost: () => true }),
      getPtyHostRuntime: () => supervisor, getWebviewContextMap: () => new Map(),
    });
    vi.spyOn(ShellDetector, 'getDefaultShell').mockReturnValue({ name: 'bash', path: '/bin/bash', args: [], isAvailable: true });
    const panel: ToolPanel = {
      id: 'owned', sessionId: 'session-owned', type: 'terminal', title: 'Claude',
      state: { isActive: true, customState: {
        agentType: 'claude', agentLaunch: { executable: '/path with spaces/claude', args: ['--model', 'sonnet'] },
        agentSessionId: '22222222-2222-4222-8222-222222222222', hasClaudeSessionId: true,
        initialInput: 'next prompt', initialInputMode: 'stdin', isCliReady: false,
      } },
      metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    };
    vi.spyOn(panelManager, 'getPanel').mockReturnValue(panel);
    vi.spyOn(panelManager, 'updatePanel').mockResolvedValue(undefined);
    return { manager: new TerminalPanelManager(panelManager), panel, spawn, handle, dataListeners, exitListeners };
  }

  it('serializes concurrent renderer and session initialization across an asynchronous PTY spawn', async () => {
    const { manager, panel, spawn } = fixture();
    panel.state.customState = { ...panel.state.customState,
      hasClaudeSessionId: false, initialInput: '--model evil', initialInputMode: 'argument',
    };
    const spawned = Promise.withResolvers<{ ptyId: string; pid: number }>();
    spawn.mockReturnValue(spawned.promise);
    const first = manager.initializeTerminal(panel, '/worktree');
    const second = manager.initializeTerminal(panel, '/worktree');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    spawned.resolve({ ptyId: 'pty-1', pid: 123 });
    await first;
    await vi.advanceTimersByTimeAsync(10);
    await second;
    expect(spawn).toHaveBeenCalledTimes(1);
    const invocation = process.platform === 'win32'
      ? { shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', "$ErrorActionPreference = 'Stop'; & '/path with spaces/claude' '--model' 'sonnet' '--session-id' '22222222-2222-4222-8222-222222222222' '--' '--model evil'; exit $LASTEXITCODE"] }
      : { shell: '/bin/bash', args: ['-l', '-c', "exec '/path with spaces/claude' '--model' 'sonnet' '--session-id' '22222222-2222-4222-8222-222222222222' '--' '--model evil'"] };
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining(invocation));
    expect(manager.isCommandBoundTerminal(panel.id)).toBe(true);
    manager.destroyTerminal(panel.id, false);
  });

  it('discards readiness and pending prompt delivery after a failed launch or agent exit', async () => {
    const { manager, panel, handle, dataListeners, exitListeners } = fixture();
    await manager.initializeTerminal(panel, '/worktree');
    for (const listener of dataListeners) listener('Claude failed to start');
    for (const listener of exitListeners) listener(1, null);
    await vi.advanceTimersByTimeAsync(10000);
    await manager.saveAllTerminalStates();
    expect(manager.isTerminalInitialized(panel.id)).toBe(false);
    expect(manager.isCommandBoundTerminal(panel.id)).toBe(false);
    expect(handle.write).not.toHaveBeenCalled();
    expect(panel.state.customState).toMatchObject({ isCliReady: false });
  });

  it('persists the final answer before disposing an exited terminal or restarting it', async () => {
    const { manager, panel, spawn, dataListeners, exitListeners } = fixture();
    await manager.initializeTerminal(panel, '/worktree');
    const snapshot = Promise.withResolvers<void>();
    const flush = TerminalStateEmulator.prototype.waitForIdle;
    vi.spyOn(TerminalStateEmulator.prototype, 'waitForIdle').mockImplementation(async function (this: TerminalStateEmulator) {
      await snapshot.promise;
      await flush.call(this);
    });
    for (const listener of dataListeners) listener('Final answer before exit');
    for (const listener of exitListeners) listener(0, null);
    expect(manager.isTerminalInitialized(panel.id)).toBe(false);
    const restarted = manager.initializeTerminal(panel, '/worktree');
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
    const persisted = manager.saveTerminalState(panel.id);
    snapshot.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await persisted;
    expect(panelManager.updatePanel).toHaveBeenCalledWith(panel.id, {
      state: expect.objectContaining({ customState: expect.objectContaining({
        scrollbackBuffer: expect.stringContaining('Final answer before exit'),
        cwd: '/worktree',
      }) }),
    });
    await restarted;
    expect(spawn).toHaveBeenCalledTimes(2);
    manager.destroyTerminal(panel.id, false);
  });
});

describe('TerminalPanelManager terminal resize', () => {
  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.useRealTimers();
  });

  it('deduplicates ordinary same-size resizes but holds an actual redraw transition', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ResizeAccess>(new TerminalPanelManager(panelManager));
    const terminal = createTerminal({ outputBuffer: '' });
    manager.terminals.set(terminal.panelId, terminal);

    await manager.resizeTerminal(terminal.panelId, 80, 24);
    expect(terminal.pty.resize).not.toHaveBeenCalled();

    const redraw = manager.resizeTerminal(terminal.panelId, 80, 24, { force: true });
    expect(terminal.pty.resize).toHaveBeenNthCalledWith(1, 80, 23);
    expect(terminal.pty.resize).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await redraw;
    expect(terminal.pty.resize).toHaveBeenNthCalledWith(2, 80, 24);
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager shell prompt scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createPromptPty() {
    let listener: ((data: string) => void) | undefined;
    const dispose = vi.fn();
    const terminal = createTerminal();
    return {
      pty: {
        ...terminal.pty,
        onData: vi.fn((nextListener: (data: string) => void) => {
          listener = nextListener;
          return { dispose };
        }),
      },
      emit(data: string) {
        listener?.(data);
      },
      dispose,
    };
  }

  it('waits for the shell to settle after detecting its prompt', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager(panelManager));
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('user@host:~$ ');

    await vi.advanceTimersByTimeAsync(299);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(promptPty.dispose).toHaveBeenCalledTimes(1);
  });

  it('invokes once when repeated prompts race the fallback', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager(panelManager));
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('\x1b[32m$\x1b[0m ');
    promptPty.emit('\x1b[32m$\x1b[0m ');

    await vi.runAllTimersAsync();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(promptPty.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back after five seconds when no prompt is detected', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager(panelManager));
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('loading shell configuration\r\n');

    await vi.advanceTimersByTimeAsync(4999);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

function createConfigManagerStub(): ConfigManager {
  return partialMock<ConfigManager>({
    getUsePtyHost: () => false,
  });
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

    const manager = new TerminalPanelManager(panelManager);
    const terminal = createTerminal();

    testAccess<FlushOutputBufferAccess>(manager).flushOutputBuffer(terminal);

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

    const manager = new TerminalPanelManager(panelManager);
    const terminal = createTerminal({ isVisible: false });

    testAccess<FlushOutputBufferAccess>(manager).flushOutputBuffer(terminal);

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

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager(panelManager));
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

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager(panelManager));
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

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager(panelManager));
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
    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager(panelManager));
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
    const manager = testAccess<SnapshotAccess>(new TerminalPanelManager(panelManager));
    const screenEmulator = new TerminalStateEmulator(40, 5);
    screenEmulator.write('\x1b[?1049h\x1b[Hagent screen');
    await screenEmulator.waitForIdle();
    const terminal = createTerminal({
      scrollbackBuffer: 'scrollback',
      alternateScreenBuffer: 'screen',
      screenEmulator,
      isAlternateScreen: true,
      currentCommand: 'codex',
      capturedAgentSessionId: 'agent-session-1',
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
      activityStatus: 'idle',
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

  it('serves normal-buffer restore content from the rendered emulator, not the raw append log', async () => {
    const manager = testAccess<SnapshotAccess>(new TerminalPanelManager(panelManager));
    const screenEmulator = new TerminalStateEmulator(40, 5);
    const frame = 'PR #363 state unchanged';
    // Live stream: the frame prints once, then forced-redraw repaints re-emit it
    // after cursor-home — the traffic that duplicated rows when the raw log was
    // replayed. The emulator overwrites in place, like a live terminal.
    const initial = `${frame}\r\n`;
    const repaint = `\x1b[H${frame}\x1b[K\r\n`;
    screenEmulator.write(initial);
    screenEmulator.write(repaint);
    screenEmulator.write(repaint);
    await screenEmulator.waitForIdle();
    const terminal = createTerminal({
      scrollbackBuffer: initial + repaint + repaint,
      screenEmulator,
      isAlternateScreen: false,
    });
    manager.terminals.set(terminal.panelId, terminal);

    const restoreState = await manager.getTerminalState(terminal.panelId);
    const restored = restoreState?.scrollbackBuffer;
    expect(restored).toBeDefined();
    if (restored === undefined) throw new Error('Expected restored scrollback');
    expect(restored.split(frame).length - 1).toBe(1);
    expect(terminal.scrollbackBuffer.split(frame).length - 1).toBe(3);
    screenEmulator.dispose();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('submits Codex initial input through the composer sequence', async () => {
    vi.useFakeTimers();
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager(panelManager));
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
    const manager = testAccess<InitialInputAccess & TerminalPanelManager>(new TerminalPanelManager(panelManager));
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
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager(panelManager));
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
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager(panelManager));
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
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager(panelManager));
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
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));

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
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));
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
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));

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
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));
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

  it('preserves approval mode and model when resuming Claude', () => {
    // SAFETY: Exercise the launch resolver without creating a PTY.
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));
    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --model sonnet',
      { agentType: 'claude', hasClaudeSessionId: true, agentSessionId: '22222222-2222-4222-8222-222222222222' },
    );
    expect(result.commandToRun).toBe('claude --model sonnet --resume 22222222-2222-4222-8222-222222222222');
  });

  it('keeps resumed Claude input composer-bound', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));

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
      'claude --dangerously-skip-permissions --resume 22222222-2222-4222-8222-222222222222',
    );
    expect(result.customState).not.toHaveProperty('initialInputSentAt');
  });

  it('launches a fresh Cursor panel through the create-chat compound', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
    });

    expect(result).toMatchObject({
      commandToRun:
        'if __PANE_CURSOR_CHAT="$(cursor-agent create-chat 2>/dev/null)" && [ -n "$__PANE_CURSOR_CHAT" ]; '
        + 'then printf \'\\npane-cursor-chat-id: %s\\n\' "$__PANE_CURSOR_CHAT"; '
        + 'cursor-agent --force --trust --resume "$__PANE_CURSOR_CHAT"; '
        + 'else cursor-agent --force --trust; fi',
      isCliCommand: true,
      customState: {
        agentType: 'cursor',
        isCliPanel: true,
        isCliReady: false,
      },
    });
  });

  it('passes fresh Cursor initial input as a startup prompt argument on both compound branches', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      initialInputMode: 'argument',
      initialInput: 'Read "the guide" and initialize `Pane Chat`.',
    });

    const quoted = '"Read \\"the guide\\" and initialize \\`Pane Chat\\`."';
    expect(result.commandToRun).toContain(`--resume "$__PANE_CURSOR_CHAT" ${quoted}; `);
    expect(result.commandToRun).toContain(`else cursor-agent --force --trust ${quoted}; fi`);
    expect(result.customState).toMatchObject({
      agentType: 'cursor',
      initialInputSentAt: expect.any(String),
      initialInputError: undefined,
    });
  });

  it('uses fish-compatible syntax for a fresh Cursor launch in fish', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
    }, 'fish');

    expect(result.commandToRun).toBe(
      'if set __PANE_CURSOR_CHAT (cursor-agent create-chat 2>/dev/null); and test -n "$__PANE_CURSOR_CHAT"; '
      + 'printf \'\\npane-cursor-chat-id: %s\\n\' "$__PANE_CURSOR_CHAT"; '
      + 'cursor-agent --force --trust --resume "$__PANE_CURSOR_CHAT"; '
      + 'else; cursor-agent --force --trust; end',
    );
  });

  it('resumes an interrupted Cursor panel with its captured chat id', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      wasInterrupted: true,
      agentSessionId: '7403f755-6758-40d3-bb69-2cd356dd9bf0',
    });

    expect(result).toMatchObject({
      commandToRun: 'cursor-agent --force --trust --resume "7403f755-6758-40d3-bb69-2cd356dd9bf0"',
      isCliCommand: true,
      customState: {
        agentType: 'cursor',
        wasInterrupted: undefined,
      },
    });
  });

  it('continues the latest Cursor chat when an interrupted panel has no captured id', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager(panelManager));

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      wasInterrupted: true,
    });

    expect(result).toMatchObject({
      commandToRun: 'cursor-agent --force --trust --continue',
      isCliCommand: true,
      customState: {
        wasInterrupted: undefined,
      },
    });
  });

  it('keeps Enter as the default initial input submit strategy', async () => {
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager(panelManager));
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

describe('TerminalPanelManager agent session capture', () => {
  const CURSOR_CHAT_ID = '7403f755-6758-40d3-bb69-2cd356dd9bf0';

  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
  });

  const mockPanel = (agentType: string, initialCommand: string, panelId = 'panel-1') => {
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: panelId,
      sessionId: 'session-1',
      type: 'terminal',
      title: 'Agent',
      state: {
        isActive: true,
        customState: { agentType, initialCommand, isCliPanel: true },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });
  };

  it('persists the Cursor chat id scraped from the marker line', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager(panelManager));
    const terminal = createTerminal({ agentType: 'cursor' });
    mockPanel('cursor', 'cursor-agent --force --trust');

    manager.captureAgentSessionId(terminal, `\r\npane-cursor-chat-id: ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBe(CURSOR_CHAT_ID);
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-1', {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'cursor', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('still captures Codex resume ids from screen output', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager(panelManager));
    const terminal = createTerminal({ agentType: 'codex' });
    mockPanel('codex', 'codex --yolo');

    manager.captureAgentSessionId(terminal, `To continue, run codex resume ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBe(CURSOR_CHAT_ID);
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-1', {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'codex', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('ignores marker lines when the panel is not a cursor panel', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager(panelManager));
    const terminal = createTerminal({ agentType: 'codex' });
    mockPanel('codex', 'codex --yolo');

    manager.captureAgentSessionId(terminal, `pane-cursor-chat-id: ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBeUndefined();
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('persists the captured session id for the terminal agent on state save', async () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager(panelManager));
    const terminal = createTerminal({ agentType: 'cursor', capturedAgentSessionId: CURSOR_CHAT_ID });
    manager.terminals.set(terminal.panelId, terminal);
    mockPanel('cursor', 'cursor-agent --force --trust');

    await manager.saveTerminalState(terminal.panelId);

    expect(panelManager.updatePanel).toHaveBeenCalledWith(terminal.panelId, {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'cursor', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager destroyAllTerminals', () => {
  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
  });

  it('kills every PTY even when one terminal fails to flush', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = testAccess<DestroyAllAccess>(new TerminalPanelManager(panelManager));
    const doomed = createTerminal({ panelId: 'panel-throws' });
    const healthy = createTerminal({ panelId: 'panel-ok' });
    manager.terminals.set(doomed.panelId, doomed);
    manager.terminals.set(healthy.panelId, healthy);
    // The production event-sink fanout rethrows its first subscriber error, so
    // one destroyed webContents is enough to make this throw during quit.
    vi.spyOn(manager, 'flushOutputBuffer').mockImplementation((terminal) => {
      if (terminal.panelId === doomed.panelId) throw new Error('event sink exploded');
    });

    manager.destroyAllTerminals();

    // The throwing terminal must still be killed: the map is cleared straight
    // after this loop, so a skipped kill leaves nothing able to reclaim it.
    expect(doomed.pty.kill).toHaveBeenCalled();
    expect(healthy.pty.kill).toHaveBeenCalled();
    expect(manager.terminals.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Final output flush failed'),
      expect.anything(),
    );
    warn.mockRestore();
  });
});
