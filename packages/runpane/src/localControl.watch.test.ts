import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPaneDaemonEndpoint } from './daemonClient';
import { runPanelsAwait, runPanelsAwaitAny, runPanelsEvents, runPanelsWatch, runPanesStatus, runPanesWatch } from './localControl';
import type { ParsedArgs } from './commands';

type EventType = 'panel_created' | 'terminal_ready' | 'prompt_staged' | 'prompt_submitted' | 'agent_active'
  | 'agent_idle' | 'input_required' | 'blocked' | 'unblocked' | 'panel_exited' | 'panel_archived';

class FakeDaemon {
  readonly paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-watch-test-'));
  readonly endpoint = getPaneDaemonEndpoint(this.paneDir).path;
  readonly server = net.createServer();
  readonly sockets = new Set<net.Socket>();
  events: Array<ReturnType<typeof semanticEvent>> = [];
  state = panelState('active');
  expire = false;
  suppressLive = false;
  eventRequests = 0;
  duringReplay?: ReturnType<typeof semanticEvent>;
  panelsByPane = new Map<string, Array<{ id: string; paneId: string; type: string }>>([
    ['pane-1', [{ id: 'panel-1', paneId: 'pane-1', type: 'terminal' }]],
  ]);
  statusResponse?: { ok: true; paneId: string; panels: Array<{ panelId: string; paneId: string; state: ReturnType<typeof panelState> }>; cursor: string };
  statusRequests: Array<Record<string, unknown>> = [];
  duringPanelList?: ReturnType<typeof semanticEvent>;

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.endpoint), { recursive: true });
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as { id: number; channel: string; args: Array<Record<string, unknown>> };
          buffer = buffer.slice(newline + 1);
          this.respond(socket, request);
          newline = buffer.indexOf('\n');
        }
      });
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.endpoint, resolve);
    });
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    fs.rmSync(this.paneDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(this.endpoint), { recursive: true, force: true });
  }

  append(type: EventType, state = this.state, live = true, ids: { panelId?: string; paneId?: string } = {}): ReturnType<typeof semanticEvent> {
    const event = semanticEvent(this.events.length + 1, type, state, ids);
    this.events.push(event);
    if (live && !this.suppressLive) this.broadcast(event);
    return event;
  }

  broadcast(event: ReturnType<typeof semanticEvent>): void {
    const frame = `${JSON.stringify({ type: 'event', channel: 'panel:semanticEvent', args: [event] })}\n`;
    for (const socket of this.sockets) socket.write(frame);
  }

  private respond(socket: net.Socket, request: { id: number; channel: string; args: Array<Record<string, unknown>> }): void {
    if (request.channel === 'runpane:panels:screen') {
      const panelId = typeof request.args[0]?.panelId === 'string' ? request.args[0].panelId : 'panel-1';
      const paneId = this.paneIdForPanel(panelId) ?? 'pane-1';
      this.writeResponse(socket, request.id, { ok: true, panelId, paneId, source: 'empty', limit: 80, returnedLineCount: 0, hasMore: false, text: '', state: this.state });
      return;
    }
    if (request.channel === 'runpane:panels:list') {
      const paneId = String(request.args[0]?.paneId ?? 'pane-1');
      if (this.duringPanelList) {
        const interleaved = this.duringPanelList;
        this.duringPanelList = undefined;
        this.events.push(interleaved);
        this.broadcast(interleaved);
      }
      this.writeResponse(socket, request.id, { ok: true, paneId, panels: this.panelsByPane.get(paneId) ?? [] });
      return;
    }
    if (request.channel === 'runpane:panes:status') {
      this.statusRequests.push(request.args[0] ?? {});
      this.writeResponse(socket, request.id, this.statusResponse ?? {
        ok: true,
        paneId: 'pane-1',
        panels: [{ panelId: 'panel-1', paneId: 'pane-1', state: this.state }],
        cursor: `epoch:${this.events.length}`,
      });
      return;
    }
    if (request.channel !== 'runpane:panels:events') throw new Error(`Unexpected channel ${request.channel}`);
    this.eventRequests += 1;
    if (this.expire) {
      this.writeResponse(socket, request.id, { ok: false, error: { code: 'cursor_expired', earliestCursor: 'epoch:5', reconcileCommand: 'runpane panes status --json' } });
      return;
    }
    const since = request.args[0]?.since;
    const n = typeof since === 'string' ? Number(since.split(':')[1]) : this.events.length;
    const replay = this.events.filter(event => Number(event.cursor.split(':')[1]) > n);
    if (this.duringReplay) {
      const interleaved = this.duringReplay;
      this.duringReplay = undefined;
      this.events.push(interleaved);
      this.broadcast(interleaved);
    }
    this.writeResponse(socket, request.id, { ok: true, events: replay, cursor: `epoch:${this.events.length}` });
  }

  private writeResponse(socket: net.Socket, id: number, result: unknown): void {
    socket.write(`${JSON.stringify({ type: 'response', id, ok: true, result })}\n`);
  }

  private paneIdForPanel(panelId: string): string | undefined {
    for (const panels of this.panelsByPane.values()) {
      const panel = panels.find(candidate => candidate.id === panelId);
      if (panel) return panel.paneId;
    }
    return undefined;
  }
}

function semanticEvent(n: number, type: EventType, state = panelState('active'), ids: { panelId?: string; paneId?: string } = {}) {
  return {
    id: `epoch:${n}`,
    cursor: `epoch:${n}`,
    type,
    at: new Date().toISOString(),
    paneId: ids.paneId ?? 'pane-1',
    panelId: ids.panelId ?? 'panel-1',
    state,
  };
}
function panelState(activity: 'active' | 'idle' | 'exited') {
  return { initialized: true, terminalReady: true, agentActivity: activity, blocked: false, inputRequired: false };
}
function parsed(command: ParsedArgs['command'], paneDir: string, extra: Partial<ParsedArgs> = {}): ParsedArgs {
  return { command, target: 'client', paneVersion: 'latest', channel: 'stable', format: 'auto', dryRun: false, yes: false, verbose: false, json: true, remoteSetupArgs: [], paneDir, panelId: 'panel-1', ...extra };
}

let daemon: FakeDaemon | undefined;
afterEach(() => { daemon?.close(); daemon = undefined; vi.restoreAllMocks(); });

describe('semantic event wrapper', () => {
  it('phase3 AC1: await-any identifies the winning panelId and paneId', async () => {
    daemon = new FakeDaemon();
    daemon.panelsByPane.set('pane-2', [{ id: 'panel-2', paneId: 'pane-2', type: 'terminal' }]);
    daemon.duringPanelList = semanticEvent(1, 'agent_idle', panelState('idle'), { panelId: 'panel-2', paneId: 'pane-2' });
    await daemon.start();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const promise = runPanelsAwaitAny(parsed('panels await-any', daemon.paneDir, {
      eventSelector: 'agent-idle',
      panelIds: ['panel-1'],
      paneIds: ['pane-2'],
      timeoutMs: 500,
    }));

    expect(await promise).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}')) as {
      event?: { panelId?: string; paneId?: string };
      matchedEvent?: string;
    };
    expect(result).toMatchObject({
      matchedEvent: 'agent_idle',
      event: { panelId: 'panel-2', paneId: 'pane-2' },
    });
  });

  it('MF-4: await-any captures a matching event emitted during pane resolution', async () => {
    daemon = new FakeDaemon();
    daemon.panelsByPane.set('pane-2', [{ id: 'panel-2', paneId: 'pane-2', type: 'terminal' }]);
    daemon.duringPanelList = semanticEvent(1, 'prompt_staged', panelState('active'), { panelId: 'panel-2', paneId: 'pane-2' });
    await daemon.start();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runPanelsAwaitAny(parsed('panels await-any', daemon.paneDir, {
      eventSelector: 'prompt-staged',
      paneIds: ['pane-2'],
      timeoutMs: 100,
    }))).toBe(0);

    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}')) as {
      event?: { panelId?: string; paneId?: string };
      resolvedBy?: string;
    };
    expect(result).toMatchObject({
      resolvedBy: 'event',
      event: { panelId: 'panel-2', paneId: 'pane-2' },
    });
  });

  it('MF-4 Python parity: await-any captures a matching event emitted during pane resolution', async () => {
    daemon = new FakeDaemon();
    daemon.panelsByPane.set('pane-2', [{ id: 'panel-2', paneId: 'pane-2', type: 'terminal' }]);
    daemon.duringPanelList = semanticEvent(1, 'prompt_staged', panelState('active'), { panelId: 'panel-2', paneId: 'pane-2' });
    await daemon.start();

    const result = await runPython(daemon.paneDir, [
      'panels', 'await-any',
      '--pane', 'pane-2',
      '--event', 'prompt-staged',
      '--timeout-ms', '500',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"panelId":"panel-2"');
    expect(result.stdout).toContain('"paneId":"pane-2"');
  }, 30_000);

  it('phase3 AC2: panes watch include-future-panels emits panel_created and later transitions', async () => {
    daemon = new FakeDaemon(); await daemon.start();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });

    const promise = runPanesWatch(parsed('panes watch', daemon.paneDir, {
      paneIds: ['pane-1'],
      includeFuturePanels: true,
      jsonl: true,
    }));
    await new Promise(resolve => setTimeout(resolve, 40));
    daemon.append('panel_created', panelState('active'), true, { panelId: 'panel-new', paneId: 'pane-1' });
    daemon.append('agent_active', panelState('active'), true, { panelId: 'panel-new', paneId: 'pane-1' });
    await new Promise(resolve => setTimeout(resolve, 40));
    process.emit('SIGINT');

    expect(await promise).toBe(0);
    expect(writes.map(line => (JSON.parse(line) as { type: string; panelId: string; paneId: string })))
      .toMatchObject([
        { type: 'panel_created', panelId: 'panel-new', paneId: 'pane-1' },
        { type: 'agent_active', panelId: 'panel-new', paneId: 'pane-1' },
      ]);
  });

  it('phase3 AC3: panes status changed-since returns changed panels and cursor for gap-free watch', async () => {
    daemon = new FakeDaemon();
    daemon.statusResponse = {
      ok: true,
      paneId: 'pane-1',
      panels: [{ panelId: 'panel-2', paneId: 'pane-1', state: panelState('idle') }],
      cursor: 'epoch:2',
    };
    daemon.events.push(
      semanticEvent(1, 'agent_active', panelState('active'), { panelId: 'panel-1', paneId: 'pane-1' }),
      semanticEvent(2, 'agent_idle', panelState('idle'), { panelId: 'panel-2', paneId: 'pane-1' }),
    );
    await daemon.start();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((chunk: string) => { logs.push(chunk); });

    expect(await runPanesStatus(parsed('panes status', daemon.paneDir, {
      paneId: 'pane-1',
      changedSince: 'epoch:1',
    }))).toBe(0);
    expect(daemon.statusRequests).toEqual([{ paneId: 'pane-1', changedSince: 'epoch:1' }]);
    const status = JSON.parse(logs[0]) as { panels: Array<{ panelId: string }>; cursor: string };
    expect(status.panels.map(panel => panel.panelId)).toEqual(['panel-2']);
    expect(status.cursor).toBe('epoch:2');

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    const watch = runPanesWatch(parsed('panes watch', daemon.paneDir, {
      paneIds: ['pane-1'],
      includeFuturePanels: true,
      since: status.cursor,
      jsonl: true,
    }));
    await new Promise(resolve => setTimeout(resolve, 40));
    daemon.append('agent_active', panelState('active'), true, { panelId: 'panel-2', paneId: 'pane-1' });
    await new Promise(resolve => setTimeout(resolve, 40));
    process.emit('SIGINT');

    expect(await watch).toBe(0);
    expect(writes.map(line => (JSON.parse(line) as { cursor: string }).cursor)).toEqual(['epoch:3']);
  });

  it('AC1 remains blocked while ready and active, then resolves agent-idle on an idle transition', async () => {
    daemon = new FakeDaemon(); await daemon.start();
    const promise = runPanelsAwait(parsed('panels await', daemon.paneDir, { eventSelector: 'agent-idle', timeoutMs: 500 }));
    let settled = false; void promise.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 40)); expect(settled).toBe(false);
    daemon.state = panelState('idle'); daemon.append('agent_idle', daemon.state);
    expect(await promise).toBe(0);
  });

  it('AC2/AC3 watch emits one compact complete JSONL record for one transition and none while unchanged', async () => {
    daemon = new FakeDaemon(); await daemon.start();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    const promise = runPanelsWatch(parsed('panels watch', daemon.paneDir, { jsonl: true }));
    await new Promise(resolve => setTimeout(resolve, 40));
    daemon.append('agent_active');
    await new Promise(resolve => setTimeout(resolve, 40));
    process.emit('SIGINT');
    expect(await promise).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].split('\n').filter(Boolean)).toHaveLength(1);
    const record = JSON.parse(writes[0]) as Record<string, unknown>;
    expect(record).toMatchObject({ id: 'epoch:1', cursor: 'epoch:1', type: 'agent_active', paneId: 'pane-1', panelId: 'panel-1' });
    expect(JSON.stringify(record)).not.toContain('screen');
  });

  it('AC4 merges an event broadcast during replay exactly once in numeric cursor order', async () => {
    daemon = new FakeDaemon(); daemon.events.push(semanticEvent(1, 'agent_active'));
    daemon.duringReplay = semanticEvent(2, 'agent_idle', panelState('idle')); await daemon.start();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    const promise = runPanelsWatch(parsed('panels watch', daemon.paneDir, { since: 'epoch:0' }));
    await new Promise(resolve => setTimeout(resolve, 60)); process.emit('SIGINT'); expect(await promise).toBe(0);
    expect(writes.map(line => (JSON.parse(line) as { cursor: string }).cursor)).toEqual(['epoch:1', 'epoch:2']);
  });

  it('AC5/AC6 reports structured cursor_expired on stderr with exit 3', async () => {
    daemon = new FakeDaemon(); daemon.expire = true; await daemon.start();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runPanelsEvents(parsed('panels events', daemon.paneDir, { since: 'old:1' }))).toBe(3);
    expect(error.mock.calls.flat().join(' ')).toContain('cursor_expired');
    expect(error.mock.calls.flat().join(' ')).toContain('reconcileCommand');
  });

  it.each([['agent-idle', 'agent_idle'], ['prompt-staged', 'prompt_staged']] as const)(
    'AC7 heartbeat recovers suppressed %s delivery and marks reconciliation', async (selector, type) => {
      daemon = new FakeDaemon(); daemon.suppressLive = true; await daemon.start();
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const promise = runPanelsAwait(parsed('panels await', daemon.paneDir, { eventSelector: selector, timeoutMs: 500, heartbeatMs: 40 }));
      await new Promise(resolve => setTimeout(resolve, 15));
      daemon.state = selector === 'agent-idle' ? panelState('idle') : daemon.state;
      daemon.append(type, daemon.state);
      expect(await promise).toBe(0);
      expect(log.mock.calls.flat().join(' ')).toContain('"resolvedBy":"reconciliation"');
    },
  );

  it('AC8 timeout returns current reconciled state and distinct exit 2', async () => {
    daemon = new FakeDaemon(); await daemon.start();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runPanelsAwait(parsed('panels await', daemon.paneDir, { eventSelector: 'blocked', timeoutMs: 40, heartbeatMs: 1000 }))).toBe(2);
    expect(log.mock.calls.flat().join(' ')).toContain('"timedOut":true');
    expect(log.mock.calls.flat().join(' ')).toContain('"agentActivity":"active"');
  });

  it('heartbeat remains periodic while unrelated panel events keep arriving', async () => {
    daemon = new FakeDaemon(); await daemon.start();
    const promise = runPanelsWatch(parsed('panels watch', daemon.paneDir, { heartbeatMs: 30 }));
    await new Promise(resolve => setTimeout(resolve, 30));
    for (let n = 1; n <= 5; n += 1) {
      daemon.broadcast({ ...semanticEvent(n, 'agent_active'), panelId: 'panel-other' });
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    process.emit('SIGINT'); expect(await promise).toBe(0);
    expect(daemon.eventRequests).toBeGreaterThanOrEqual(3);
  });

  it('Python parity: replay/live handshake is ordered and clean SIGINT exits 0', async () => {
    daemon = new FakeDaemon(); daemon.events.push(semanticEvent(1, 'agent_active'));
    daemon.duringReplay = semanticEvent(2, 'agent_idle', panelState('idle')); await daemon.start();
    const result = await runPython(daemon.paneDir, ['panels', 'watch', '--panel', 'panel-1', '--since', 'epoch:0', '--jsonl'], 2);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n').map(line => (JSON.parse(line) as { cursor: string }).cursor)).toEqual(['epoch:1', 'epoch:2']);
  }, 30_000);

  it('Python parity: heartbeat recovery, cursor expiry, timeout, and transport use exit codes 0/3/2/1', async () => {
    daemon = new FakeDaemon(); daemon.suppressLive = true; await daemon.start();
    const recoveredPromise = runPython(daemon.paneDir, ['panels', 'await', '--panel', 'panel-1', '--event', 'prompt-staged', '--heartbeat-ms', '40', '--timeout-ms', '500', '--json']);
    while (daemon.sockets.size === 0) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 30)); daemon.append('prompt_staged');
    const recovered = await recoveredPromise;
    expect(recovered.code).toBe(0); expect(recovered.stdout).toContain('"resolvedBy":"reconciliation"');

    daemon.expire = true;
    const expired = await runPython(daemon.paneDir, ['panels', 'events', '--since', 'old:1', '--json']);
    expect(expired.code).toBe(3); expect(expired.stderr).toContain('cursor_expired');
    daemon.expire = false;
    const timeout = await runPython(daemon.paneDir, ['panels', 'await', '--panel', 'panel-1', '--event', 'blocked', '--timeout-ms', '30', '--json']);
    expect(timeout.code).toBe(2); expect(timeout.stdout).toContain('"timedOut":true');
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-missing-'));
    const transport = await runPython(missingDir, ['panels', 'events', '--json']);
    fs.rmSync(missingDir, { recursive: true, force: true });
    expect(transport.code).toBe(1);
  }, 30_000);
});

function runPython(paneDir: string, args: string[], stopAfterLines = 0): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-m', 'runpane', ...args], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: path.resolve(process.cwd(), '../runpane-py/src'), PANE_DIR: paneDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let stopped = false;
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!stopped && stopAfterLines > 0 && stdout.split('\n').filter(Boolean).length >= stopAfterLines) {
        stopped = true; child.kill('SIGINT');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
