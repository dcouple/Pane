import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPanelManager } from './terminalPanelManager';
import { TerminalStateEmulator } from './terminalStateEmulator';
import { AgentStatusMonitor } from './agentStatus/agentStatusMonitor';
import { WorkspaceJournal } from './workspaceJournal';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import type { PaneEventArgument } from '../core/eventSink';
import { createFlowControlRecord, disposeFlowControlRecord } from '../ptyHost/flowControl';
import { panelManager } from '../test/setup';
import { formatWaitResult } from '../../../packages/runpane/src/watchLines';

function createTerminal(agentType: 'claude' | 'codex' | undefined = 'codex') {
  let onData: (data: string) => void = () => undefined;
  let onExit: (exit: { exitCode: number; signal?: number }) => void = () => undefined;
  const terminal = {
    panelId: 'p', sessionId: 's', agentType, pendingInitialCommand: false,
    pty: {
      onData: (listener: typeof onData) => { onData = listener; },
      onExit: (listener: typeof onExit) => { onExit = listener; },
      write: vi.fn(), kill: vi.fn(), cols: 80, rows: 24, pid: process.pid,
    },
    screenEmulator: new TerminalStateEmulator(80, 24),
    scrollbackBuffer: '', alternateScreenBuffer: '', commandHistory: [],
    currentCommand: '', lastActivity: new Date(), outputGeneration: 0,
    flowControl: createFlowControlRecord(), outputBuffer: '',
    // SAFETY: PTY output handlers assign timeout handles; fixtures start without one.
    outputFlushTimer: null as ReturnType<typeof setTimeout> | null,
    isVisible: true, isAlternateScreen: false, inSyncBlock: false,
    filterInAltScreen: false, agentSessionScrapeBuffer: '',
  };
  return { terminal, data: (data: string) => onData(data), exit: (exit: { exitCode: number; signal?: number } = { exitCode: 0 }) => onExit(exit) };
}

type TerminalFixture = ReturnType<typeof createTerminal>;
interface StatusAccess {
  terminals: Map<string, TerminalFixture['terminal']>;
  agentStatusMonitor: AgentStatusMonitor;
  setupTerminalHandlers(terminal: TerminalFixture['terminal']): void;
  pollAgentStatus(): Promise<void>;
  sendInitialInputOnce(panelId: string): void;
  getProcessCwd(pid: number): Promise<string>;
}

let manager: TerminalPanelManager;
let access: StatusAccess;
let journal: WorkspaceJournal;
let fixtures: TerminalFixture[];
let events: Array<{ channel: string; payload: PaneEventArgument }>;

function attach(agentType?: 'claude' | 'codex', startedAt = 0) {
  const fixture = createTerminal(agentType);
  fixtures.push(fixture);
  access.terminals.set('p', fixture.terminal);
  access.agentStatusMonitor.register('p', startedAt);
  access.setupTerminalHandlers(fixture.terminal);
  return fixture;
}

beforeEach(() => {
  // xterm writes need real timers; only the status clock is controlled.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(20_000);
  fixtures = [];
  events = [];
  manager = new TerminalPanelManager();
  // SAFETY: This seam mirrors the private members used by these PTY fixtures.
  access = manager as StatusAccess;
  journal = new WorkspaceJournal({
    resolvePane: paneId => ({ paneId, paneName: 'Pane' }),
    resolvePanel: panelId => ({ panelId, paneId: 's', isCliPanel: true }),
  });
  setPaneRuntime({ eventSink: { send(channel, payload) {
    events.push({ channel, payload });
    journal.send(channel, payload);
  } } });
  panelManager.emitPanelEvent.mockImplementation((panelId, type, data) => {
    journal.send('panel:event', { type, source: { panelId, sessionId: 's' }, data });
  });
});

afterEach(() => {
  for (const { terminal } of fixtures) {
    if (terminal.outputFlushTimer) clearTimeout(terminal.outputFlushTimer);
    terminal.screenEmulator.dispose();
    disposeFlowControlRecord(terminal.flowControl);
  }
  journal.dispose();
  resetPaneRuntimeForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  panelManager.getPanel.mockReset();
  panelManager.updatePanel.mockReset();
});

describe('terminal status events', () => {
  it('keeps idle waits pending during boot and delayed command injection', async () => {
    const fixture = attach('codex', 20_000);
    vi.setSystemTime(20_500);
    await access.pollAgentStatus();
    expect(manager.getAgentStatus('p')).toBeUndefined();
    expect(manager.getTerminalSnapshot('p')?.activityStatus).toBe('active');
    fixture.terminal.pendingInitialCommand = true;
    vi.setSystemTime(24_500);
    await access.pollAgentStatus();
    expect(manager.getAgentStatus('p')).toBeUndefined();
    expect(manager.getTerminalSnapshot('p')?.activityStatus).toBe('active');
    fixture.terminal.pendingInitialCommand = false;
    fixture.data('\x1b]2;Codex\x07');
    await access.pollAgentStatus();
    expect(manager.getTerminalSnapshot('p')?.activityStatus).toBe('idle');
    expect(journal.readAfter(0).entries).toEqual([]);
  });

  it('publishes consistent idle status on exit and deduplicates repeated callbacks', async () => {
    const fixture = attach('codex');
    fixture.data('\x1b]2;⠙ Codex\x07');
    await access.pollAgentStatus();
    fixture.exit();
    fixture.exit();
    expect(events.filter(event => event.channel === 'panel:activityStatus').at(-1)?.payload).toMatchObject({ status: 'idle' });
    expect(events.filter(event => event.channel === 'terminal:exited')).toHaveLength(1);
    expect(manager.getAgentStatus('p')).toBeUndefined();
    expect(journal.readAfter(0).entries.map(entry => entry.kind)).toEqual(['agent.busy', 'panel.exited']);
  });

  it('retires destroyed terminals before old exit and data callbacks can affect a replacement', async () => {
    vi.spyOn(manager, 'saveTerminalState').mockResolvedValue();
    const old = attach('codex');
    old.data('\x1b]2;⠙ Codex\x07');
    await access.pollAgentStatus();
    await manager.destroyTerminal('p');
    expect(events.filter(event => event.channel === 'panel:agentStatus').at(-1)?.payload).toMatchObject({ state: 'idle', reason: 'destroyed' });
    expect(journal.readAfter(0).entries.map(entry => entry.kind)).toEqual(['agent.busy', 'panel.exited']);
    expect(formatWaitResult({ epoch: journal.epoch, ...journal.readAfter(0) }, 'lines').some(line => line.startsWith('READY'))).toBe(false);
    const replacement = attach('codex');
    replacement.data('\x1b]2;⠙ Codex\x07');
    await access.pollAgentStatus();
    const count = events.length;
    old.exit();
    old.data('old output');
    expect(events).toHaveLength(count);
    expect(manager.isTerminalInitialized('p')).toBe(true);
    expect(manager.getAgentStatus('p')).toBe('working');
    replacement.exit();
    expect(journal.readAfter(0).entries.filter(entry => entry.kind === 'panel.exited')).toHaveLength(2);
  });

  it('skips snapshot persistence when the panel is being deleted', async () => {
    const fixture = attach('codex');
    const save = vi.spyOn(manager, 'saveTerminalState');
    await manager.destroyTerminal('p', { saveState: false });
    expect(save).not.toHaveBeenCalled();
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
    expect(manager.isTerminalInitialized('p')).toBe(false);
  });

  it.each([
    { label: 'live PTY', exit: undefined },
    { label: 'successful exit', exit: { exitCode: 0 } },
    { label: 'signaled exit', exit: { exitCode: 17, signal: 9 } },
  ])('drains and saves before disposal, preserving an exit during teardown ($label)', async ({ exit }) => {
    const fixture = attach('codex');
    panelManager.getPanel.mockReturnValue({
      id: 'p', sessionId: 's', type: 'terminal', title: 'Codex',
      state: { isActive: true, customState: { cwd: '/old' } },
      metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    });
    vi.spyOn(access, 'getProcessCwd').mockResolvedValue('/live');
    fixture.data('last output before archive');
    const destroying = manager.destroyTerminal('p');
    expect(fixture.terminal.pty.kill).not.toHaveBeenCalled();
    expect(manager.destroyTerminal('p')).toBe(destroying);
    // Closing callbacks cannot dispose the model before queued writes drain.
    if (exit) fixture.exit(exit);
    fixture.data('output after teardown began');
    manager.writeToTerminal('p', 'late input');
    expect(fixture.terminal.pty.write).not.toHaveBeenCalled();
    await destroying;
    expect(panelManager.updatePanel).toHaveBeenCalledWith('p', { state: expect.objectContaining({
      customState: expect.objectContaining({ cwd: '/live', scrollbackBuffer: expect.stringContaining('last output before archive') }),
    }) });
    if (exit) expect(fixture.terminal.pty.kill).not.toHaveBeenCalled();
    else expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
    expect(journal.readAfter(0).entries).toMatchObject([{
      kind: 'panel.exited', exitCode: exit?.exitCode,
      reason: exit?.signal === undefined ? 'terminal:exit' : `signal:${exit.signal}`,
    }]);
    fixture.exit();
    expect(journal.readAfter(0).entries).toHaveLength(1);
  });

  it.each(['cwd read', 'emulator drain'])('does not persist or retire a replacement during teardown %s', async phase => {
    const old = attach('codex');
    panelManager.getPanel.mockReturnValue({
      id: 'p', sessionId: 's', type: 'terminal', title: 'Codex',
      state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    });
    let release: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(access, 'getProcessCwd').mockImplementation(async () => {
      if (phase === 'cwd read') await pending;
      return '/live';
    });
    if (phase === 'emulator drain') vi.spyOn(old.terminal.screenEmulator, 'waitForIdle').mockReturnValue(pending);
    const destroying = manager.destroyTerminal('p');
    await Promise.resolve();
    const replacement = attach('codex');
    replacement.data('\x1b]2;⠙ Codex\x07');
    release();
    await destroying;
    await access.pollAgentStatus();
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    expect(replacement.terminal.pty.kill).not.toHaveBeenCalled();
    expect(manager.getAgentStatus('p')).toBe('working');
  });

  it('still retires and kills the terminal when saving fails', async () => {
    const fixture = attach('codex');
    vi.spyOn(manager, 'saveTerminalState').mockRejectedValue(new Error('persistence failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await manager.destroyTerminal('p');
    expect(error).toHaveBeenCalled();
    expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
    expect(manager.isTerminalInitialized('p')).toBe(false);
  });

  it('discards a poll resumed after the terminal was replaced', async () => {
    const old = attach('codex');
    let release = () => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(old.terminal.screenEmulator, 'waitForIdle').mockReturnValue(pending);
    const polling = access.pollAgentStatus();
    const replacement = attach('codex');
    replacement.data('\x1b]2;⠙ Codex\x07');
    release();
    await polling;
    await access.pollAgentStatus();
    expect(events.filter(event => event.channel === 'panel:agentStatus').map(event => event.payload)).toEqual([
      { panelId: 'p', sessionId: 's', state: 'working', reason: 'osc_title_working' },
    ]);
  });

  it.each(['persistence', 'submit delay'])('does not send an old initial prompt after replacement during %s', async phase => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(20_000);
    const old = attach('codex');
    let release: () => void = () => undefined;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    panelManager.getPanel.mockReturnValue({
      id: 'p', sessionId: 's', type: 'terminal', title: 'Codex',
      state: { isActive: true, customState: { initialInput: 'old task', initialInputSubmitStrategy: 'codex-ctrl-enter' } },
      metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    });
    panelManager.updatePanel.mockReturnValue(persisted);
    access.sendInitialInputOnce('p');
    if (phase === 'submit delay') {
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(old.terminal.pty.write).toHaveBeenCalledWith('old task');
    }
    const replacement = attach('codex');
    release();
    await vi.advanceTimersByTimeAsync(500);
    expect(replacement.terminal.pty.write).not.toHaveBeenCalled();
    panelManager.getPanel.mockReset();
    panelManager.updatePanel.mockReset();
  });

  it('retains tracking after a write error until actual exit evidence arrives', async () => {
    const fixture = attach('codex');
    fixture.data('\x1b]2;⠙ Codex\x07');
    await access.pollAgentStatus();
    fixture.terminal.pty.write.mockImplementation(() => { throw new Error('write failed'); });
    manager.writeToTerminal('p', 'hello');
    expect(manager.isTerminalInitialized('p')).toBe(true);
    fixture.data('\x1b]2;Codex\x07');
    await access.pollAgentStatus();
    expect(manager.getAgentStatus('p')).toBe('idle');
    fixture.exit();
    expect(manager.getAgentStatus('p')).toBeUndefined();
  });

  it.each(['claude', 'codex'] as const)('does not publish work or completion from %s typing and cursor redraws', async agent => {
    const fixture = attach(agent);
    const title = agent === 'claude' ? '✳ Project' : 'Project';
    fixture.data(`\x1b]2;${title}\x07Finished.\r\n› `);
    await access.pollAgentStatus();
    expect(manager.getAgentStatus('p')).toBe('idle');
    fixture.data('\x1b[?25l');
    fixture.data('\x1b[?25h');
    fixture.data('draft input');
    await access.pollAgentStatus();
    vi.setSystemTime(40_000);
    await access.pollAgentStatus();
    expect(events.filter(event => event.channel === 'panel:agentStatus')).toEqual([
      { channel: 'panel:agentStatus', payload: { panelId: 'p', sessionId: 's', state: 'idle', reason: 'osc_title_idle' } },
    ]);
    expect(journal.readAfter(0).entries).toEqual([]);
    expect(formatWaitResult({ epoch: journal.epoch, ...journal.readAfter(0) }, 'lines')).toEqual([]);
  });

  it('reports immediate real work and completion with coherent reasons', async () => {
    const fixture = attach('claude', 20_000);
    fixture.data('\x1b]2;✳ Project\x07');
    await access.pollAgentStatus();
    manager.writeToTerminal('p', 'go\r');
    fixture.data('\x1b]2;◐ Building\x07');
    await access.pollAgentStatus();
    expect(manager.getAgentStatus('p')).toBe('working');
    fixture.data('\x1b]2;✳ Project\x07Done.');
    await access.pollAgentStatus();
    expect(manager.getAgentStatus('p')).toBe('idle');
    expect(journal.readAfter(0).entries.map(entry => [entry.kind, entry.reason])).toEqual([
      ['agent.busy', 'osc_title_working'], ['agent.ready', 'osc_title_idle'],
    ]);
    expect(formatWaitResult({ epoch: journal.epoch, ...journal.readAfter(0) }, 'lines')).toEqual([
      'BUSY Pane pane s panel p', 'READY Pane pane s panel p',
    ]);
  });
});
