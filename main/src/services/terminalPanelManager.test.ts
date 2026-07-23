import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import { createFlowControlRecord, disposeFlowControlRecord, type FlowControlRecord } from '../ptyHost/flowControl';
import { TerminalStateEmulator } from './terminalStateEmulator';
import type { ToolPanel } from '../../../shared/types/panels';

const ptySpawn = vi.hoisted(() => vi.fn());
const semanticAppend = vi.hoisted(() => vi.fn());
vi.mock('@lydell/node-pty', () => ({ spawn: ptySpawn }));

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

import { normalizeAgentIdleDebounceMs, TerminalPanelManager } from './terminalPanelManager';
import { panelManager } from './panelManager';

type ExitEvent = { exitCode: number; signal?: number };

type TerminalUnderTest = {
  pty: {
    cols: number;
    rows: number;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (event: ExitEvent) => void): { dispose(): void };
    emitData(data: string): void;
    emitExit(event: ExitEvent): void;
  };
  ptyId?: string;
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
  isWSL?: boolean;
  wslContext: null;
  flowControl: FlowControlRecord;
  outputBuffer: string;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  isVisible: boolean;
  isAlternateScreen: boolean;
  activityStatus: 'active' | 'idle';
  idleTimer: ReturnType<typeof setTimeout> | null;
  agentActivity: 'unknown' | 'starting' | 'active' | 'idle' | 'exited';
  agentIdleTimer: ReturnType<typeof setTimeout> | null;
  lastMeaningfulEventAt: string;
  outputGenerationAtQuiescence: number;
  exitEventHandled: boolean;
  suppressSemanticExitPersistence: boolean;
  lastKnownBlocker?: { kind: 'agent-prompt' | 'codex-update' | 'submission_unverified' | 'unknown'; message: string };
  blockerScanTimer: ReturnType<typeof setTimeout> | null;
  lastBlockerScanAt: number;
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

type SemanticStateAccess = {
  terminals: Map<string, TerminalUnderTest>;
  setupTerminalHandlers(terminal: TerminalUnderTest): void;
  stampMeaningfulEvent(terminal: TerminalUnderTest, at?: Date): void;
  getTerminalSnapshot(panelId: string): ReturnType<TerminalPanelManager['getTerminalSnapshot']>;
  writeToTerminal(panelId: string, data: string): void;
  destroyTerminal(panelId: string): void;
  destroyAllTerminals(): void;
  respawnAll(): Promise<void>;
  initializeTerminal: TerminalPanelManager['initializeTerminal'];
};

function createTerminal(overrides: Partial<TerminalUnderTest> = {}): TerminalUnderTest {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: ExitEvent) => void>();
  return {
    pty: {
      cols: 80,
      rows: 24,
      pause: vi.fn(),
      resume: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onData(listener) {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
      onExit(listener) {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
      emitData(data) {
        for (const listener of [...dataListeners]) listener(data);
      },
      emitExit(event) {
        for (const listener of [...exitListeners]) listener(event);
      },
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
    agentActivity: 'starting',
    agentIdleTimer: null,
    lastMeaningfulEventAt: new Date().toISOString(),
    outputGenerationAtQuiescence: 0,
    exitEventHandled: false,
    suppressSemanticExitPersistence: false,
    blockerScanTimer: null,
    lastBlockerScanAt: 0,
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

function createConfigManagerStub(agentIdleDebounceMs?: unknown): ConfigManager {
  return {
    getUsePtyHost: () => false,
    getPreferredShell: () => 'auto',
    getConfig: () => ({ agentIdleDebounceMs }),
  } as ConfigManager;
}

function createPanel(customState: Record<string, unknown> = {}): ToolPanel {
  return {
    id: 'panel-1',
    sessionId: 'session-1',
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: true, customState },
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      position: 0,
    },
  };
}

function installRuntime(agentIdleDebounceMs?: unknown): { send: ReturnType<typeof vi.fn> } {
  const eventSink = { send: vi.fn() };
  setPaneRuntime({
    eventSink,
    daemonEventSink: { send: vi.fn() },
    getRunpaneEventLog: () => ({ append: semanticAppend }) as never,
    getConfigManager: () => createConfigManagerStub(agentIdleDebounceMs),
    getPtyHostRuntime: () => null,
    getWebviewContextMap: () => new Map(),
  });
  return eventSink;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalPanelManager semantic agent state', () => {
  afterEach(() => {
    resetPaneRuntimeForTests();
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    ptySpawn.mockReset();
    semanticAppend.mockReset();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([1_000, 45_000])(
    'AC2/AC3 transitions active to idle at configured debounce %dms, not N-1',
    async (debounceMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      installRuntime(debounceMs);
      const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
      const terminal = createTerminal({ outputBuffer: '' });
      manager.terminals.set(terminal.panelId, terminal);
      manager.setupTerminalHandlers(terminal);

      terminal.pty.emitData('working');
      const activeAt = terminal.lastMeaningfulEventAt;
      expect(terminal.agentActivity).toBe('active');

      await vi.advanceTimersByTimeAsync(debounceMs - 1);
      expect(terminal.agentActivity).toBe('active');

      await vi.advanceTimersByTimeAsync(1);
      expect(terminal.agentActivity).toBe('idle');
      expect(terminal.lastMeaningfulEventAt).not.toBe(activeAt);
      expect(terminal.outputGenerationAtQuiescence).toBe(1);
      disposeFlowControlRecord(terminal.flowControl);
    },
  );

  it.each([undefined, -1, 0, 1.5, Number.NaN, '60000'])(
    'normalizes invalid agent idle debounce %s to 60000',
    (value) => {
      expect(normalizeAgentIdleDebounceMs(value)).toBe(60_000);
    },
  );

  it('preserves output freshness across output, real readiness latch, quiescence, and exit', async () => {
    vi.useFakeTimers();
    installRuntime(1_000);
    const panel = createPanel({
      initialCommand: 'codex',
      isCliPanel: true,
      isCliReady: false,
      agentType: 'codex',
    });
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const spawnedPty = createTerminal({ outputBuffer: '' }).pty;
    ptySpawn.mockReturnValue(spawnedPty);

    await manager.initializeTerminal(panel, process.cwd());
    const terminal = manager.terminals.get(panel.id);
    expect(terminal).toBeDefined();
    const hasNewOutput = () => terminal!.outputGeneration > terminal!.outputGenerationAtQuiescence;

    expect(hasNewOutput()).toBe(false);
    terminal!.pty.emitData('$ ');
    await vi.advanceTimersByTimeAsync(50);
    expect(terminal!.pty.write).toHaveBeenCalledWith('codex\r');
    expect(hasNewOutput()).toBe(true);
    const beforeReady = terminal!.lastMeaningfulEventAt;
    terminal!.pty.emitData('codex first frame');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(panel.state.customState).toMatchObject({ isCliReady: true });
    expect(terminal!.lastMeaningfulEventAt).not.toBe(beforeReady);
    expect(hasNewOutput()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(hasNewOutput()).toBe(false);
    terminal!.pty.emitData('three');
    expect(hasNewOutput()).toBe(true);
    terminal!.pty.emitExit({ exitCode: 0 });
    expect(hasNewOutput()).toBe(false);
    disposeFlowControlRecord(terminal!.flowControl);
  });

  it('MF-1: CLI-ready callback does not blindly write a premarked create initial input', async () => {
    vi.useFakeTimers();
    installRuntime(1_000);
    const panel = createPanel({
      initialCommand: 'codex',
      initialInput: '/do TM-x',
      initialInputSubmitStrategy: 'codex-ctrl-enter',
      initialInputSentAt: '2026-01-01T00:02:00.000Z',
      isCliPanel: true,
      isCliReady: false,
      agentType: 'codex',
    });
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const spawnedPty = createTerminal({ outputBuffer: '' }).pty;
    ptySpawn.mockReturnValue(spawnedPty);

    await manager.initializeTerminal(panel, process.cwd());
    const terminal = manager.terminals.get(panel.id);
    expect(terminal).toBeDefined();
    terminal!.pty.emitData('$ ');
    await vi.advanceTimersByTimeAsync(50);
    expect(terminal!.pty.write).toHaveBeenCalledWith('codex\r');
    terminal!.pty.write.mockClear();

    terminal!.pty.emitData('Do you trust this directory?\n1. Yes\n2. No\n');
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(terminal!.pty.write).not.toHaveBeenCalledWith('/do TM-x');
    expect(terminal!.pty.write).not.toHaveBeenCalledWith('\x1b[13;5u\r');
    expect(terminal!.pty.write).not.toHaveBeenCalled();
    disposeFlowControlRecord(terminal!.flowControl);
  });

  it('MF-7: delayed CLI-ready callback refuses RunPane create-owned initial input after readiness failure', async () => {
    vi.useFakeTimers();
    installRuntime(1_000);
    const panel = createPanel({
      initialCommand: 'codex',
      initialInput: '/do TM-x',
      initialInputSubmitStrategy: 'codex-ctrl-enter',
      initialInputDeliveryOwner: 'runpane-create',
      isCliPanel: true,
      isCliReady: false,
      agentType: 'codex',
    });
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const spawnedPty = createTerminal({ outputBuffer: '' }).pty;
    ptySpawn.mockReturnValue(spawnedPty);

    await manager.initializeTerminal(panel, process.cwd());
    const terminal = manager.terminals.get(panel.id);
    expect(terminal).toBeDefined();
    terminal!.pty.emitData('$ ');
    await vi.advanceTimersByTimeAsync(50);
    expect(terminal!.pty.write).toHaveBeenCalledWith('codex\r');
    terminal!.pty.write.mockClear();

    terminal!.pty.emitData('Do you trust this directory?\n1. Yes\n2. No\n');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(terminal!.pty.write).not.toHaveBeenCalledWith('/do TM-x');
    expect(terminal!.pty.write).not.toHaveBeenCalledWith('\x1b[13;5u\r');
    expect(terminal!.pty.write).not.toHaveBeenCalled();
    disposeFlowControlRecord(terminal!.flowControl);
  });

  it('AC4 persists exited activity without an intermediate semantic idle and preserves the legacy idle edge', () => {
    vi.useFakeTimers();
    const eventSink = installRuntime(5_000);
    const panel = createPanel({ isCliPanel: true, isCliReady: true });
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const terminal = createTerminal({
      outputBuffer: '',
      activityStatus: 'active',
      agentActivity: 'active',
    });
    manager.terminals.set(terminal.panelId, terminal);
    manager.setupTerminalHandlers(terminal);

    terminal.pty.emitExit({ exitCode: 7, signal: 15 });

    expect(terminal.agentActivity).toBe('exited');
    expect(terminal.outputGenerationAtQuiescence).toBe(terminal.outputGeneration);
    expect(manager.terminals.has(terminal.panelId)).toBe(false);
    expect(panel.state.customState).toMatchObject({
      exitedAt: expect.any(String),
      exitCode: 7,
      exitSignal: 15,
    });
    expect(eventSink.send).toHaveBeenCalledWith('panel:activityStatus', expect.objectContaining({
      status: 'idle',
    }));
    expect(semanticAppend).toHaveBeenCalledTimes(1);
    expect(semanticAppend).toHaveBeenCalledWith('panel_exited', panel, { paneId: 'session-1' });
    terminal.pty.emitExit({ exitCode: 7, signal: 15 });
    expect(semanticAppend).toHaveBeenCalledTimes(1);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('AC2/AC3 detects a hidden-panel blocker on the trailing scan and emits edge-only events', async () => {
    vi.useFakeTimers(); installRuntime();
    const panel = createPanel({ agentType: 'codex' });
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const terminal = createTerminal({ outputBuffer: '', isVisible: false, screenEmulator: new TerminalStateEmulator(80, 24) });
    manager.terminals.set(terminal.panelId, terminal); manager.setupTerminalHandlers(terminal);
    terminal.pty.emitData('Press Enter to continue');
    await vi.advanceTimersByTimeAsync(250);
    expect(semanticAppend.mock.calls.map(call => call[0])).toContain('blocked');
    expect(semanticAppend.mock.calls.map(call => call[0])).toContain('input_required');
    const count = semanticAppend.mock.calls.filter(call => call[0] === 'blocked' || call[0] === 'input_required').length;
    terminal.pty.emitData('\rPress Enter to continue');
    await vi.advanceTimersByTimeAsync(500);
    expect(semanticAppend.mock.calls.filter(call => call[0] === 'blocked' || call[0] === 'input_required')).toHaveLength(count);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('ignores a late exit callback from a replaced process', () => {
    installRuntime();
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const stale = createTerminal({ agentActivity: 'active' });
    const replacement = createTerminal({ agentActivity: 'starting' });
    manager.terminals.set(stale.panelId, stale);
    manager.setupTerminalHandlers(stale);
    manager.terminals.set(replacement.panelId, replacement);

    stale.pty.emitExit({ exitCode: 9 });

    expect(manager.terminals.get(stale.panelId)).toBe(replacement);
    expect(stale.agentActivity).toBe('active');
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    disposeFlowControlRecord(stale.flowControl);
    disposeFlowControlRecord(replacement.flowControl);
  });

  it('MF-1 ignores late output after removal instead of arming a semantic idle timer', async () => {
    vi.useFakeTimers();
    installRuntime(100);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const terminal = createTerminal({ outputBuffer: '' });
    manager.terminals.set(terminal.panelId, terminal);
    manager.setupTerminalHandlers(terminal);
    manager.terminals.delete(terminal.panelId);

    terminal.pty.emitData('late WSL shutdown output');

    expect(terminal.agentActivity).toBe('starting');
    expect(terminal.outputGeneration).toBe(0);
    expect(terminal.agentIdleTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(100);

    expect(terminal.agentActivity).toBe('starting');
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('MF-1 ignores late output from a replaced process instead of mutating stale semantic state', async () => {
    vi.useFakeTimers();
    installRuntime(100);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const stale = createTerminal({ outputBuffer: '' });
    const replacement = createTerminal({ outputBuffer: '', agentActivity: 'starting' });
    manager.terminals.set(stale.panelId, stale);
    manager.setupTerminalHandlers(stale);
    manager.terminals.set(replacement.panelId, replacement);

    stale.pty.emitData('late stale output');

    expect(stale.agentActivity).toBe('starting');
    expect(stale.outputGeneration).toBe(0);
    expect(stale.agentIdleTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(100);

    expect(stale.agentActivity).toBe('starting');
    expect(manager.terminals.get(stale.panelId)).toBe(replacement);
    disposeFlowControlRecord(stale.flowControl);
    disposeFlowControlRecord(replacement.flowControl);
  });

  it('MF-2 suppresses old exit persistence while respawn replacement initialization is pending', async () => {
    installRuntime();
    const panel = createPanel({ cwd: process.cwd() });
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const stale = createTerminal({ isPtyHost: true, ptyId: 'pty-restart', agentActivity: 'active' });
    manager.terminals.set(stale.panelId, stale);
    manager.setupTerminalHandlers(stale);
    let rejectReplacement!: (error: Error) => void;
    manager.initializeTerminal = vi.fn().mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectReplacement = reject;
    }));

    const respawn = manager.respawnAll();
    stale.pty.emitExit({ exitCode: 1, signal: 15 });
    await flushPromises();

    expect(panel.state.customState).not.toMatchObject({ exitedAt: expect.any(String) });
    expect(panel.state.customState).not.toHaveProperty('exitCode');
    expect(panel.state.customState).not.toHaveProperty('exitSignal');
    rejectReplacement(new Error('replacement spawn failed'));
    await respawn;
    expect(panel.state.customState).not.toMatchObject({ exitedAt: expect.any(String) });
    disposeFlowControlRecord(stale.flowControl);
  });

  it('MF-2 suppresses old exit persistence on respawnAll when the panel no longer exists', async () => {
    installRuntime();
    vi.mocked(panelManager.getPanel).mockReturnValue(undefined);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const missing = createTerminal({ isPtyHost: true, ptyId: 'pty-missing', agentActivity: 'active' });
    manager.terminals.set(missing.panelId, missing);
    manager.setupTerminalHandlers(missing);

    await manager.respawnAll();
    missing.pty.emitExit({ exitCode: 1, signal: 15 });
    await flushPromises();

    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    disposeFlowControlRecord(missing.flowControl);
  });

  it('re-initializing a previously exited panel clears exit facts and starts semantic activity', async () => {
    installRuntime();
    const panel = createPanel({
      exitedAt: '2025-12-31T00:00:00.000Z',
      exitCode: 1,
      exitSignal: 9,
    });
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const spawnedPty = createTerminal({ outputBuffer: '' }).pty;
    ptySpawn.mockReturnValue(spawnedPty);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;

    await manager.initializeTerminal(panel, process.cwd());

    expect(panel.state.customState).toMatchObject({
      exitedAt: undefined,
      exitCode: undefined,
      exitSignal: undefined,
    });
    expect(manager.getTerminalSnapshot(panel.id)?.agentActivity).toBe('starting');
    manager.destroyAllTerminals();
  });

  it('clears semantic timers armed by output across all six terminal-map removal paths', async () => {
    vi.useFakeTimers();
    installRuntime(60_000);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);

    const naturalManager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const natural = createTerminal({ outputBuffer: '' });
    vi.mocked(panelManager.getPanel).mockReturnValue(createPanel());
    naturalManager.terminals.set(natural.panelId, natural);
    naturalManager.setupTerminalHandlers(natural);
    natural.pty.emitData('working');
    expect(natural.agentIdleTimer).not.toBeNull();
    natural.pty.emitExit({ exitCode: 0 });
    expect(natural.agentIdleTimer).toBeNull();

    const writeManager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const failedWrite = createTerminal({ outputBuffer: '' });
    failedWrite.pty.write.mockImplementation(() => { throw new Error('dead'); });
    writeManager.terminals.set(failedWrite.panelId, failedWrite);
    writeManager.setupTerminalHandlers(failedWrite);
    failedWrite.pty.emitData('working');
    expect(failedWrite.agentIdleTimer).not.toBeNull();
    writeManager.writeToTerminal(failedWrite.panelId, 'x');
    expect(failedWrite.agentIdleTimer).toBeNull();

    const destroyManager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const destroyed = createTerminal({ outputBuffer: '' });
    destroyManager.terminals.set(destroyed.panelId, destroyed);
    destroyManager.setupTerminalHandlers(destroyed);
    destroyed.pty.emitData('working');
    expect(destroyed.agentIdleTimer).not.toBeNull();
    destroyManager.destroyTerminal(destroyed.panelId);
    expect(destroyed.agentIdleTimer).toBeNull();

    const missingManager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const missing = createTerminal({ isPtyHost: true, ptyId: 'pty-1', outputBuffer: '' });
    vi.mocked(panelManager.getPanel).mockReturnValue(undefined);
    missingManager.terminals.set(missing.panelId, missing);
    missingManager.setupTerminalHandlers(missing);
    missing.pty.emitData('working');
    expect(missing.agentIdleTimer).not.toBeNull();
    await missingManager.respawnAll();
    expect(missing.agentIdleTimer).toBeNull();

    const staleManager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const stale = createTerminal({ isPtyHost: true, ptyId: 'pty-2', outputBuffer: '' });
    vi.mocked(panelManager.getPanel).mockReturnValue(createPanel({ cwd: process.cwd() }));
    staleManager.initializeTerminal = vi.fn().mockResolvedValue(undefined);
    staleManager.terminals.set(stale.panelId, stale);
    staleManager.setupTerminalHandlers(stale);
    stale.pty.emitData('working');
    expect(stale.agentIdleTimer).not.toBeNull();
    await staleManager.respawnAll();
    expect(stale.agentIdleTimer).toBeNull();

    const allManager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const all = createTerminal({ outputBuffer: '' });
    const shutdownPanel = createPanel();
    vi.mocked(panelManager.getPanel).mockReturnValue(shutdownPanel);
    allManager.terminals.set(all.panelId, all);
    allManager.setupTerminalHandlers(all);
    all.pty.emitData('working');
    expect(all.agentIdleTimer).not.toBeNull();
    all.pty.kill.mockImplementation(() => all.pty.emitExit({ exitCode: 0 }));
    allManager.destroyAllTerminals();
    expect(all.agentIdleTimer).toBeNull();
    expect(shutdownPanel.state.customState).not.toMatchObject({ exitedAt: expect.any(String) });

    for (const terminal of [natural, failedWrite, destroyed, missing, stale, all]) {
      disposeFlowControlRecord(terminal.flowControl);
    }
  });

  it('destroyTerminal persists exited state for WSL and ignores late shutdown output while merging deferred exit facts', async () => {
    vi.useFakeTimers();
    installRuntime(60_000);
    const panel = createPanel();
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    const manager = new TerminalPanelManager() as unknown as SemanticStateAccess;
    const terminal = createTerminal({ isWSL: true, agentActivity: 'active', outputBuffer: '' });
    manager.terminals.set(terminal.panelId, terminal);
    manager.setupTerminalHandlers(terminal);

    manager.destroyTerminal(terminal.panelId);
    terminal.pty.emitData('logout');

    expect(panel.state.customState).toMatchObject({ exitedAt: expect.any(String) });
    expect(terminal.agentActivity).toBe('exited');
    expect(terminal.agentIdleTimer).toBeNull();
    expect(manager.terminals.has(terminal.panelId)).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(terminal.pty.kill).toHaveBeenCalled();
    terminal.pty.emitExit({ exitCode: 0, signal: 15 });
    await flushPromises();
    expect(panel.state.customState).toMatchObject({
      exitCode: 0,
      exitSignal: 15,
    });
    disposeFlowControlRecord(terminal.flowControl);
  });
});

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
