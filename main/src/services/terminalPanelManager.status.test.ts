import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPanelManager } from './terminalPanelManager';
import { TerminalStateEmulator } from './terminalStateEmulator';
import { AgentStatusMonitor } from './agentStatus/agentStatusMonitor';
import { WorkspaceJournal } from './workspaceJournal';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import type { PaneEventArgument } from '../core/eventSink';
import { createFlowControlRecord, disposeFlowControlRecord } from '../ptyHost/flowControl';
import { panelManager } from '../test/setup';

// These tests exercise PTY/status lifetimes, not the SQLite persistence boundary.
vi.mock('./database', () => ({ databaseService: {} }));

function createTerminal(agentType: 'claude' | 'codex' | undefined = 'codex') {
  let onData: (data: string) => void = () => undefined;
  let onExit: (exit: { exitCode: number; signal?: number }) => void = () => undefined;
  const terminal = {
    panelId: 'p', sessionId: 's', agentType,
    pty: {
      onData: (listener: typeof onData) => { onData = listener; },
      onExit: (listener: typeof onExit) => { onExit = listener; },
      write: vi.fn(), kill: vi.fn(), cols: 80, rows: 24,
    },
    screenEmulator: new TerminalStateEmulator(80, 24),
    scrollbackBuffer: '', alternateScreenBuffer: '', commandHistory: [],
    currentCommand: '', lastActivity: new Date(), outputGeneration: 0,
    flowControl: createFlowControlRecord(), outputBuffer: '',
    outputFlushTimer: null as ReturnType<typeof setTimeout> | null,
    isVisible: true, isAlternateScreen: false, inSyncBlock: false,
    filterInAltScreen: false, agentSessionScrapeBuffer: '',
  };
  return { terminal, data: (data: string) => onData(data), exit: () => onExit({ exitCode: 0 }) };
}

type TerminalFixture = ReturnType<typeof createTerminal>;
interface StatusAccess {
  terminals: Map<string, TerminalFixture['terminal']>;
  agentStatusMonitor: AgentStatusMonitor;
  setupTerminalHandlers(terminal: TerminalFixture['terminal']): void;
  pollAgentStatus(): Promise<void>;
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
  access = manager as unknown as StatusAccess;
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
});

describe('terminal status events', () => {
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
  });
});
