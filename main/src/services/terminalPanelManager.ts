import * as pty from '@lydell/node-pty';
import { ToolPanel, TerminalPanelState, PanelEventType } from '../../../shared/types/panels';
import { panelManager } from './panelManager';
import { mainWindow, configManager, getPtyHostSupervisor } from '../index';
import * as os from 'os';
import * as path from 'path';
import { getShellPath } from '../utils/shellPath';
import { ShellDetector } from '../utils/shellDetector';
import type { AnalyticsManager } from './analyticsManager';
import { getWSLShellSpawn, buildWSLENV, WSLContext } from '../utils/wslUtils';
import { GIT_ATTRIBUTION_ENV } from '../utils/attribution';
import type { PtyHandle, PtyHostSupervisor } from '../ptyHost/ptyHostSupervisor';
import {
  type FlowControlRecord,
  createFlowControlRecord,
  disposeFlowControlRecord,
  onAck as flowControlOnAck,
  onPtyBytes as flowControlOnPtyBytes,
} from '../ptyHost/flowControl';

const OUTPUT_BATCH_INTERVAL = 32; // ms (~30fps) — wider window reduces TUI flicker
const OUTPUT_BATCH_INTERVAL_HIDDEN = 250; // ms — background / hidden cadence to cut IPC wake-up cost
const OUTPUT_BATCH_SIZE = 131072; // 128KB — timer-based flush preferred; size trigger is safety net
const OUTPUT_BATCH_SIZE_HIDDEN = 80_000; // 80KB — cap hidden flush size to avoid foreground backpressure churn
const MAX_CONCURRENT_SPAWNS = 3;
const IDLE_THRESHOLD_MS = 30_000; // 30s — mark panel idle after no PTY output
const MAX_SCROLLBACK_BUFFER_SIZE = 500_000; // 500KB of normal shell history
const MAX_ALTERNATE_SCREEN_BUFFER_SIZE = 100_000; // 100KB of recent TUI redraw state

/**
 * IPty-compatible shim over a ptyHost `PtyHandle`.
 *
 * When the `usePtyHost` setting is on and the supervisor is available,
 * terminal spawns route through the ptyHost UtilityProcess and we get back a
 * `PtyHandle` whose methods are async. The managers treat the
 * `TerminalProcess.pty` field as a sync `IPty`; this shim preserves that
 * assumption by fire-and-forgetting the async calls (errors logged, not
 * awaited at call sites) and exposing `pid`/`cols`/`rows` synchronously.
 *
 * Critical: `pid` is cached from the spawn response so the synchronous
 * `.pid` reads in `getSessionPids()` and `killProcessTree` keep working.
 */
class PtyHandleShim implements pty.IPty {
  readonly pid: number;
  cols: number;
  rows: number;
  readonly process = 'ptyHost';
  handleFlowControl = false;
  readonly ptyId: string;
  private readonly handle: PtyHandle;

  constructor(handle: PtyHandle, cols: number, rows: number) {
    this.handle = handle;
    this.ptyId = handle.id;
    this.pid = handle.pid;
    this.cols = cols;
    this.rows = rows;
  }

  readonly onData = (listener: (data: string) => void): pty.IDisposable => {
    return this.handle.onData(listener);
  };

  readonly onExit = (
    listener: (e: { exitCode: number; signal?: number }) => void,
  ): pty.IDisposable => {
    return this.handle.onExit((exitCode, signal) => {
      listener({
        exitCode: exitCode ?? 0,
        signal: signal === null ? undefined : signal,
      });
    });
  };

  resize(columns: number, rows: number): void {
    this.cols = columns;
    this.rows = rows;
    this.handle.resize(columns, rows).catch((err: unknown) => {
      console.warn('[ptyHost] resize failed', err);
    });
  }

  clear(): void {
    // No-op on non-Windows; ptyHost does not currently expose a clear RPC.
  }

  write(data: string | Buffer): void {
    const str = typeof data === 'string' ? data : data.toString();
    this.handle.write(str).catch((err: unknown) => {
      console.warn('[ptyHost] write failed', err);
    });
  }

  kill(signal?: string): void {
    this.handle.kill(signal as NodeJS.Signals | undefined).catch((err: unknown) => {
      console.warn('[ptyHost] kill failed', err);
    });
  }

  pause(): void {
    this.handle.pause().catch((err: unknown) => {
      console.warn('[ptyHost] pause failed', err);
    });
  }

  resume(): void {
    this.handle.resume().catch((err: unknown) => {
      console.warn('[ptyHost] resume failed', err);
    });
  }
}

interface TerminalProcess {
  pty: pty.IPty;
  /** Host-allocated PTY id when routed through ptyHost; undefined under legacy `pty.spawn`. */
  ptyId?: string;
  /** True when `pty` is a `PtyHandleShim` wrapping a ptyHost handle. */
  isPtyHost: boolean;
  panelId: string;
  sessionId: string;
  scrollbackBuffer: string;
  alternateScreenBuffer: string;
  commandHistory: string[];
  currentCommand: string;
  lastActivity: Date;
  isWSL?: boolean;
  /**
   * WSL context captured at spawn time. Stored so `respawnAll` can re-inject
   * the same distro / user / WSLENV propagation after a ptyHost supervisor
   * restart without needing to reconstruct it from project state.
   */
  wslContext: WSLContext | null;
  /**
   * Flow-control bookkeeping (pending bytes, pause state, safety timer,
   * `pauseRpcInFlight` gate). Lives on the shared `FlowControlRecord` so the
   * same state-machine semantics apply to both the legacy `pty.spawn` path
   * and the ptyHost `usePtyHost` path.
   */
  flowControl: FlowControlRecord;
  // Output batching
  outputBuffer: string;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  // Visibility-driven cadence: true → OUTPUT_BATCH_INTERVAL + renderer writes,
  // false → OUTPUT_BATCH_INTERVAL_HIDDEN + main-process scrollback only.
  isVisible: boolean;
  // Alternate screen buffer tracking — universal TUI detection signal
  isAlternateScreen: boolean;
  activityStatus: 'active' | 'idle';
  idleTimer: ReturnType<typeof setTimeout> | null;
  // DEC Mode 2026 synchronized-output block tracking — persists across chunks
  inSyncBlock: boolean;
}

export class TerminalPanelManager {
  private terminals = new Map<string, TerminalProcess>();
  private serializedBuffers = new Map<string, string>();
  private readonly MAX_SCROLLBACK_LINES = 10000;
  private analyticsManager: AnalyticsManager | null = null;

  // Spawn concurrency limiter — prevents CPU spikes when many terminals init at once
  private activeSpawns = 0;
  private spawnQueue: Array<{ resolve: () => void; priority: number }> = [];

  setAnalyticsManager(analyticsManager: AnalyticsManager): void {
    this.analyticsManager = analyticsManager;
  }

  /**
   * Returns a map of sessionId → array of PTY PIDs for that session.
   * Used by resource monitoring to discover which processes belong to which session.
   */
  getSessionPids(): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const [, terminal] of this.terminals) {
      const pids = result.get(terminal.sessionId) || [];
      pids.push(terminal.pty.pid);
      result.set(terminal.sessionId, pids);
    }
    return result;
  }

  private async acquireSpawnSlot(priority: number = 1): Promise<void> {
    if (this.activeSpawns < MAX_CONCURRENT_SPAWNS) {
      this.activeSpawns++;
      return;
    }
    return new Promise(resolve => {
      this.spawnQueue.push({ resolve, priority });
      this.spawnQueue.sort((a, b) => a.priority - b.priority);
    });
  }

  private releaseSpawnSlot(): void {
    this.activeSpawns--;
    const next = this.spawnQueue.shift();
    if (next) {
      this.activeSpawns++;
      next.resolve();
    }
  }

  private trimAnsiSafe(buffer: string, maxSize: number): string {
    if (buffer.length <= maxSize) return buffer;

    let start = buffer.length - maxSize;

    // Prefer a line boundary so replay starts from a sane row.
    const nextNewline = buffer.indexOf('\n', start);
    if (nextNewline !== -1 && nextNewline < buffer.length - 1) {
      start = nextNewline + 1;
    }

    // If the cut lands inside a common ANSI escape sequence, advance past it.
    const lastEsc = buffer.lastIndexOf('\x1b', start);
    if (lastEsc !== -1) {
      let sequenceEnd = -1;
      const introducer = buffer[lastEsc + 1];

      if (introducer === '[') {
        const finalByte = buffer.slice(lastEsc + 2).search(/[@-~]/);
        sequenceEnd = finalByte === -1 ? -1 : lastEsc + 2 + finalByte;
      } else if (introducer === ']') {
        const belEnd = buffer.indexOf('\x07', lastEsc + 2);
        const stEnd = buffer.indexOf('\x1b\\', lastEsc + 2);
        if (belEnd !== -1 && stEnd !== -1) {
          sequenceEnd = Math.min(belEnd, stEnd + 1);
        } else if (belEnd !== -1) {
          sequenceEnd = belEnd;
        } else if (stEnd !== -1) {
          sequenceEnd = stEnd + 1;
        }
      } else if (introducer) {
        sequenceEnd = lastEsc + 1;
      }

      if (sequenceEnd === -1) {
        start = buffer.length;
      } else if (sequenceEnd >= start) {
        start = sequenceEnd + 1;
      }
    }

    return buffer.slice(start);
  }

  private flushOutputBuffer(terminal: TerminalProcess): void {
    if (terminal.outputFlushTimer) {
      clearTimeout(terminal.outputFlushTimer);
      terminal.outputFlushTimer = null;
    }

    if (!terminal.outputBuffer) return;

    const data = terminal.outputBuffer;
    terminal.outputBuffer = '';

    if (!terminal.isVisible) {
      // Hidden terminals run headless: keep PTY output in main scrollback, but
      // avoid waking the renderer/xterm/WebGL for every background token.
      return;
    }

    // Send batched output to renderer. Legacy path: IPC send via
    // `terminal:output`. Flag-on ptyHost path: post the filtered bytes over
    // the per-window MessagePort so `electronAPI.ptyHost.onData` subscribers
    // fire. Both paths continue to run; the renderer short-circuits the
    // legacy handler once a `ptyId` is set to avoid double-delivery.
    if (mainWindow) {
      mainWindow.webContents.send('terminal:output', {
        sessionId: terminal.sessionId,
        panelId: terminal.panelId,
        output: data
      });
    }
    if (terminal.isPtyHost && terminal.ptyId) {
      const supervisor = getPtyHostSupervisor();
      supervisor?.postDataToRenderers(terminal.ptyId, data);
    }

    // Update flow-control bookkeeping with the bytes just flushed. The record
    // owns the HIGH/LOW watermark check, the `pauseRpcInFlight` gate, and the
    // 5s safety timer; both the legacy and ptyHost paths go through the same
    // state machine (see `main/src/ptyHost/flowControl.ts`).
    flowControlOnPtyBytes(
      terminal.flowControl,
      data.length,
      () => this.pausePty(terminal),
      () => this.resumePty(terminal),
    );
  }

  /**
   * Pause the underlying PTY. Under the ptyHost flag, routes the RPC directly
   * through the supervisor; flag-off uses the legacy `pty.IPty.pause()` path.
   *
   * Returns a promise so the flow-control state machine can defer arming its
   * safety timer until the pause RPC actually lands (plan lines 619-624).
   * Legacy path resolves synchronously; ptyHost path resolves when the RPC
   * response returns.
   */
  private pausePty(terminal: TerminalProcess): Promise<void> {
    if (terminal.isPtyHost && terminal.ptyId) {
      const supervisor = getPtyHostSupervisor();
      if (supervisor) {
        return supervisor.pause(terminal.ptyId).catch((err: unknown) => {
          console.warn('[TerminalPanelManager] ptyHost pause failed', err);
        });
      }
    }
    terminal.pty.pause();
    return Promise.resolve();
  }

  /**
   * Resume the underlying PTY. Mirror of `pausePty` for the resume side.
   */
  private resumePty(terminal: TerminalProcess): void {
    if (terminal.isPtyHost && terminal.ptyId) {
      const supervisor = getPtyHostSupervisor();
      if (supervisor) {
        supervisor.resume(terminal.ptyId).catch((err: unknown) => {
          console.warn('[TerminalPanelManager] ptyHost resume failed', err);
        });
        return;
      }
    }
    terminal.pty.resume();
  }

  acknowledgeBytes(panelId: string, bytesConsumed: number): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return;

    // Delegate to the shared flow-control helper. It decrements `pendingBytes`,
    // clears the safety timer, and invokes the resume callback only when the
    // record is actually paused and bytes drop below `LOW_WATERMARK`.
    flowControlOnAck(terminal.flowControl, bytesConsumed, () => this.resumePty(terminal));
  }

  acknowledgePtyHostBytes(ptyId: string, bytesConsumed: number): void {
    for (const [panelId, terminal] of this.terminals) {
      if (terminal.ptyId === ptyId) {
        this.acknowledgeBytes(panelId, bytesConsumed);
        return;
      }
    }
  }

  setVisibility(panelId: string, isVisible: boolean): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return;
    const wasVisible = terminal.isVisible;
    terminal.isVisible = isVisible;
    if (wasVisible === isVisible) return;

    if (!isVisible) {
      // Once hidden, renderer ACKs stop. Do not leave a visible-mode pause
      // pending against bytes the renderer may never acknowledge.
      terminal.outputBuffer = '';
      const wasPaused = terminal.flowControl.isPaused;
      disposeFlowControlRecord(terminal.flowControl);
      if (wasPaused) {
        this.resumePty(terminal);
      }
    } else {
      // Hidden output is already present in scrollbackBuffer. Drop any stale
      // hidden batch so the renderer can refresh exactly once from getState.
      terminal.outputBuffer = '';
    }
  }

  // Reset flow control state - useful for recovering from stuck terminals
  resetFlowControl(panelId: string): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return;

    console.log(`[TerminalPanelManager] Resetting flow control for panel ${panelId}`);

    const wasPaused = terminal.flowControl.isPaused;
    // Dispose clears timers, paused state, and pending bytes on the record.
    disposeFlowControlRecord(terminal.flowControl);

    // If we interrupted a paused PTY, explicitly resume so bytes flow again.
    if (wasPaused) {
      this.resumePty(terminal);
    }
  }

  async initializeTerminal(panel: ToolPanel, cwd: string, wslContext?: WSLContext | null, priority: number = 1, initialDimensions?: { cols: number; rows: number }): Promise<void> {
    if (this.terminals.has(panel.id)) {
      return;
    }

    // Wait for a spawn slot (caps concurrent PTY spawns to prevent CPU spikes)
    await this.acquireSpawnSlot(priority);

    // Re-check after waiting — another call may have initialized this panel
    if (this.terminals.has(panel.id)) {
      this.releaseSpawnSlot();
      return;
    }

    try {

    let shellPath: string;
    let shellArgs: string[];
    let spawnCwd: string | undefined = cwd;

    if (wslContext && process.platform === 'win32') {
      const wslShell = getWSLShellSpawn(wslContext.distribution, cwd);
      shellPath = wslShell.path;
      shellArgs = wslShell.args;
      spawnCwd = undefined; // WSL handles cwd
    } else {
      const preferredShell = configManager.getPreferredShell();
      const shellInfo = ShellDetector.getDefaultShell(preferredShell);
      shellPath = shellInfo.path;
      shellArgs = shellInfo.args || [];
    }

    const isLinux = process.platform === 'linux';
    const enhancedPath = isLinux ? (process.env.PATH || '') : getShellPath();

    /**
     * PANE_PORT: deterministic port block per session (10 consecutive ports).
     * Avoids port conflicts when running parallel worktree dev servers.
     * Hash the sessionId to a port in the 3000–8990 range (600 blocks of 10).
     * Usage in pane.json: { "scripts": { "run": "PORT=$PANE_PORT pnpm dev" } }
     */
    let portHash = 0;
    for (let i = 0; i < panel.sessionId.length; i++) {
      portHash = ((portHash << 5) - portHash) + panel.sessionId.charCodeAt(i);
      portHash |= 0;
    }
    const panePort = 3000 + (Math.abs(portHash) % 600) * 10;

    /**
     * When spawning into WSL, pty.spawn's `env` sets variables on the wsl.exe
     * Windows process, which does NOT propagate them to the bash shell inside
     * the distro. WSLENV is Microsoft's opt-in mechanism: listing a var name
     * here tells WSL to copy that var's value from the Windows env into the
     * Linux env at shell startup. Without this, GIT_COMMITTER_* (and every
     * PANE_* var) silently disappear inside WSL terminals.
     */
    const isWSL = !!wslContext && process.platform === 'win32';
    const wslEnvVars: Record<string, string> = isWSL
      ? {
          WSLENV: buildWSLENV([
            'GIT_COMMITTER_NAME',
            'GIT_COMMITTER_EMAIL',
            'PANE_PORT',
            'PANE_SESSION_ID',
            'PANE_PANEL_ID',
            'WORKTREE_PATH',
            'PANE_WORKSPACE_PATH',
          ]),
        }
      : {};

    // Build spawn env once so legacy and ptyHost paths receive identical values.
    const spawnCols = initialDimensions?.cols || 80;
    const spawnRows = initialDimensions?.rows || 30;

    // `process.env` is `NodeJS.ProcessEnv` which allows `undefined` values; the
    // ptyHost RPC DTO requires `Record<string, string>`. Drop undefined keys so
    // both the legacy `pty.spawn` path and the ptyHost path see the same shape.
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        baseEnv[key] = value;
      }
    }
    const spawnEnv: Record<string, string> = {
      ...baseEnv,
      ...GIT_ATTRIBUTION_ENV,
      PATH: enhancedPath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      WORKTREE_PATH: cwd,
      PANE_SESSION_ID: panel.sessionId,
      PANE_PANEL_ID: panel.id,
      PANE_PORT: String(panePort),
      PANE_WORKSPACE_PATH: cwd,
      ...wslEnvVars,
    };

    // Read the setting once per spawn so we don't scatter config reads.
    // `getPtyHostSupervisor()` returns null when the setting is off or when
    // supervisor startup failed; in either case we transparently fall back to
    // the legacy `pty.spawn` path.
    const useFlag = configManager.getUsePtyHost();
    let supervisor: PtyHostSupervisor | null = null;
    if (useFlag) {
      supervisor = getPtyHostSupervisor();
      if (!supervisor) {
        console.warn('[ptyHost] supervisor unavailable, falling back to legacy pty.spawn');
      }
    }
    const usePtyHost = !!supervisor;

    let ptyProcess: pty.IPty;
    let ptyHostId: string | undefined;

    if (usePtyHost && supervisor) {
      // Flag-on path: spawn via ptyHost UtilityProcess. Critical invariant:
      // `this.terminals.set(...)` happens only AFTER the spawn response lands
      // so synchronous `.pid` readers (getSessionPids, killProcessTree) never
      // observe a pid-less handle.
      const spawned = await supervisor.spawn({
        shell: shellPath,
        args: shellArgs,
        cwd: spawnCwd,
        cols: spawnCols,
        rows: spawnRows,
        env: spawnEnv,
        name: 'xterm-256color',
      });
      const handle = supervisor.getHandle(spawned.ptyId);
      if (!handle) {
        throw new Error(`[ptyHost] supervisor returned ptyId=${spawned.ptyId} but getHandle() was undefined`);
      }
      ptyProcess = new PtyHandleShim(handle, spawnCols, spawnRows);
      ptyHostId = spawned.ptyId;
    } else {
      // Flag-off path: legacy direct pty.spawn. Unchanged behavior.
      ptyProcess = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: spawnCols,
        rows: spawnRows,
        cwd: spawnCwd,
        env: spawnEnv,
      });
    }

    // Create terminal process object
    const terminalProcess: TerminalProcess = {
      pty: ptyProcess,
      ptyId: ptyHostId,
      isPtyHost: usePtyHost,
      panelId: panel.id,
      sessionId: panel.sessionId,
      scrollbackBuffer: '',
      alternateScreenBuffer: '',
      commandHistory: [],
      currentCommand: '',
      lastActivity: new Date(),
      isWSL: !!(wslContext && process.platform === 'win32'),
      // Capture wslContext so `respawnAll` can re-inject the same WSLENV /
      // distro / user settings after a ptyHost supervisor restart without
      // having to reconstruct it from project state.
      wslContext: wslContext ?? null,
      flowControl: createFlowControlRecord(),
      outputBuffer: '',
      outputFlushTimer: null,
      isVisible: true,
      isAlternateScreen: false,
      activityStatus: 'idle',
      idleTimer: null,
      inSyncBlock: false
    };

    // Store in map (ptyHost path: pid is already populated on the shim).
    this.terminals.set(panel.id, terminalProcess);

    // Tell the renderer which `ptyId` to subscribe to for this panel so
    // `TerminalPanel.tsx` can use `electronAPI.ptyHost.onData(ptyId, ...)`
    // under the flag. Flag-off path skips this: the renderer keeps using
    // the legacy `terminal:output` channel.
    if (usePtyHost && ptyHostId && mainWindow) {
      mainWindow.webContents.send('terminal:ptyReady', {
        sessionId: panel.sessionId,
        panelId: panel.id,
        ptyId: ptyHostId,
      });
    }
    
    // Get initialCommand from existing state before updating
    const existingState = panel.state.customState as TerminalPanelState | undefined;
    const initialCommand = existingState?.initialCommand;

    // If we have an initial command, set up the prompt detection listener BEFORE
    // setupTerminalHandlers so we don't miss early shell output.
    let commandToRun: string | undefined;
    if (initialCommand) {
      commandToRun = initialCommand;

      // Mark CLI tool panels so the frontend can show an init overlay
      const isCliCommand = initialCommand.toLowerCase().includes('claude') ||
        initialCommand.toLowerCase().includes('codex');
      if (isCliCommand) {
        const cliState = panel.state;
        const cliCs = (cliState.customState || {}) as TerminalPanelState;
        cliCs.isCliPanel = true;
        cliCs.isCliReady = false; // Reset on (re-)launch so the overlay shows for fresh CLI processes
        cliState.customState = cliCs;
        // Will be persisted below — either by the claude-specific block or the explicit call after it
      }

      // If this is a Claude CLI command, inject --session-id or --resume
      if (
        initialCommand.toLowerCase().includes('claude') &&
        !initialCommand.includes('--session-id') &&
        !initialCommand.includes('--resume')
      ) {
        const termState = existingState as TerminalPanelState | undefined;
        if (termState?.hasClaudeSessionId) {
          commandToRun = `claude --resume ${panel.id} --dangerously-skip-permissions`;
        } else {
          commandToRun = `${initialCommand} --session-id ${panel.id}`;
        }

        // Mark that we've assigned a session ID to this panel
        // (isCliPanel is already set above and will be included here)
        const updatedState = panel.state;
        const cs = (updatedState.customState || {}) as TerminalPanelState;
        cs.hasClaudeSessionId = true;
        updatedState.customState = cs;
        panelManager.updatePanel(panel.id, { state: updatedState });
      } else if (isCliCommand) {
        // Non-claude CLI (e.g. codex) — persist the isCliPanel flag explicitly
        panelManager.updatePanel(panel.id, { state: panel.state });
      }

      // Detect the interactive prompt before injecting the command.
      // Previous approaches (fixed 500ms delay, then fire-on-any-data + 300ms) failed
      // because shell init output (MINGW banner, .bashrc) fires before the prompt is ready.
      // We check only the LAST line of the latest data chunk for a prompt pattern,
      // so banner lines ending with % or > don't trigger a false positive.
      const panelId = panel.id;
      let commandInjected = false;
      // Match prompt symbol allowing trailing ANSI escapes and whitespace
      // eslint-disable-next-line no-control-regex
      const promptPattern = /[$#%>]\s*(?:\x1b\[[0-9;]*[a-zA-Z])*\s*$/;

      const injectCommand = () => {
        if (commandInjected) return;
        commandInjected = true;
        onPromptReady.dispose();
        this.writeToTerminal(panelId, commandToRun! + '\r');

        // For CLI tool terminals, signal the frontend when the CLI responds
        if (isCliCommand) {
          let cliReadySignaled = false;
          // Declare before signalCliReady so the closure can reference it
          let onCliOutput: ReturnType<typeof ptyProcess.onData> | null = null;

          const signalCliReady = () => {
            if (cliReadySignaled) return;
            cliReadySignaled = true;
            if (onCliOutput) onCliOutput.dispose();

            // Persist isCliReady on panel state (best-effort, fire-and-forget)
            const currentPanel = panelManager.getPanel(panelId);
            if (currentPanel) {
              const ps = currentPanel.state;
              const cs2 = (ps.customState || {}) as TerminalPanelState;
              cs2.isCliReady = true;
              ps.customState = cs2;
              panelManager.updatePanel(panelId, { state: ps }); // async, not awaited
            }

            // Emit to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('terminal:cliReady', { panelId });
            }
          };

          // Listen for first CLI output after command injection.
          // Dispose immediately on first data, then fire a single delayed signal.
          onCliOutput = ptyProcess.onData(() => {
            if (onCliOutput) onCliOutput.dispose();
            onCliOutput = null;
            // Small delay to let the CLI render its first frame
            setTimeout(signalCliReady, 300);
          });

          // Safety timeout: dismiss after 10s regardless
          setTimeout(signalCliReady, 10000);
        }
      };

      const onPromptReady = ptyProcess.onData((data: string) => {
        if (commandInjected) return;
        // Only check the last line of the most recent chunk to avoid
        // matching prompt-like characters in earlier banner/init output.
        // Strip ANSI escape sequences before matching so colored prompts
        // (e.g. "user@host:~$ \x1b[0m") are detected correctly.
        const lastLine = data.split(/\r?\n/).filter(l => l.length > 0).pop() || '';
        // eslint-disable-next-line no-control-regex
        const cleanLine = lastLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (promptPattern.test(cleanLine)) {
          // Prompt detected — shell is interactive and ready for input.
          setTimeout(injectCommand, 50);
        }
      });

      // Safety timeout: if prompt is never detected within 5s, inject anyway
      setTimeout(injectCommand, 5000);
    }

    // Set up event handlers
    this.setupTerminalHandlers(terminalProcess);

    // Update panel state
    const state = panel.state;
    state.customState = {
      ...state.customState,
      isInitialized: true,
      cwd: cwd,
      shellType: path.basename(shellPath),
      dimensions: { cols: initialDimensions?.cols || 80, rows: initialDimensions?.rows || 30 }
    } as TerminalPanelState;

    await panelManager.updatePanel(panel.id, { state });

    } finally {
      this.releaseSpawnSlot();
    }
  }

  /**
   * Strips \x1b[2J (clear-screen) sequences that appear inside DEC Mode 2026
   * synchronized-output blocks. Claude Code uses these blocks for full-screen
   * redraws; the clear-screen causes xterm.js to reset scroll position, yanking
   * users away from where they were reading. State (inSyncBlock) persists across
   * chunk boundaries on the terminal object.
   */
  private filterSyncBlockClears(terminal: TerminalProcess, data: string): string {
    const SYNC_START = '\x1b[?2026h';
    const SYNC_END   = '\x1b[?2026l';
    const CLEAR      = '\x1b[2J';

    // Fast path: no sync sequences and not already inside a block
    if (!terminal.inSyncBlock && !data.includes(SYNC_START)) {
      return data;
    }

    let result = '';
    let i = 0;

    while (i < data.length) {
      if (data.startsWith(SYNC_START, i)) {
        terminal.inSyncBlock = true;
        result += SYNC_START;
        i += SYNC_START.length;
      } else if (data.startsWith(SYNC_END, i)) {
        terminal.inSyncBlock = false;
        result += SYNC_END;
        i += SYNC_END.length;
      } else if (terminal.inSyncBlock && data.startsWith(CLEAR, i)) {
        // Strip the clear-screen — scroll position preserved in xterm.js
        i += CLEAR.length;
      } else {
        result += data[i];
        i++;
      }
    }

    return result;
  }

  private setupTerminalHandlers(terminal: TerminalProcess): void {
    // Handle terminal output
    terminal.pty.onData((data: string) => {
      // Update last activity
      terminal.lastActivity = new Date();

      // Activity status transition: mark active on first byte after idle
      if (terminal.activityStatus !== 'active') {
        terminal.activityStatus = 'active';
        this.emitActivityStatus(terminal);
      }
      if (terminal.idleTimer) clearTimeout(terminal.idleTimer);
      terminal.idleTimer = setTimeout(() => {
        terminal.activityStatus = 'idle';
        terminal.idleTimer = null;
        this.emitActivityStatus(terminal);
      }, IDLE_THRESHOLD_MS);

      // Detect alternate screen buffer enter/exit for universal TUI detection
      // (works on WSL where pty.process reports wsl.exe instead of the Linux foreground app)
      // \x1b[?1049h = enter alternate screen, \x1b[?1049l = leave alternate screen
      const enterAlt = data.includes('\x1b[?1049h');
      const leaveAlt = data.includes('\x1b[?1049l');
      if (enterAlt || leaveAlt) {
        // If both appear in the same chunk, last one wins
        const lastEnter = data.lastIndexOf('\x1b[?1049h');
        const lastLeave = data.lastIndexOf('\x1b[?1049l');
        const newState = lastEnter > lastLeave;
        if (newState !== terminal.isAlternateScreen) {
          terminal.isAlternateScreen = newState;
          if (mainWindow) {
            mainWindow.webContents.send('terminal:alternateScreen', {
              panelId: terminal.panelId,
              active: newState
            });
          }
        }
      }

      // Strip \x1b[2J inside DEC 2026 sync blocks before xterm.js sees the data
      const filtered = this.filterSyncBlockClears(terminal, data);

      // Keep TUI redraw traffic separate from durable shell scrollback. Full-screen
      // apps emit high-volume cursor/clear sequences that are useful only as a
      // recent visual frame and should not evict normal history.
      this.addToScrollback(terminal, filtered);

      // Detect commands (simple heuristic - look for carriage returns)
      if (data.includes('\r') || data.includes('\n')) {
        if (terminal.currentCommand.trim()) {
          terminal.commandHistory.push(terminal.currentCommand);

          // Emit command executed event
          panelManager.emitPanelEvent(
            terminal.panelId,
            'terminal:command_executed',
            {
              command: terminal.currentCommand,
              timestamp: new Date().toISOString()
            }
          );

          // Check for file operation commands
          if (this.isFileOperationCommand(terminal.currentCommand)) {
            panelManager.emitPanelEvent(
              terminal.panelId,
              'files:changed',
              {
                command: terminal.currentCommand,
                timestamp: new Date().toISOString()
              }
            );
          }

          terminal.currentCommand = '';
        }
      } else {
        // Accumulate command input
        terminal.currentCommand += data;
      }

      // Buffer output for batching instead of sending immediately
      terminal.outputBuffer += filtered;

      // Hidden panels cap per-flush size below HIGH_WATERMARK so a single
      // flush on a verbose background build can't alone trip backpressure.
      const sizeThreshold = terminal.isVisible ? OUTPUT_BATCH_SIZE : OUTPUT_BATCH_SIZE_HIDDEN;
      if (terminal.outputBuffer.length >= sizeThreshold) {
        // Buffer is large enough — flush immediately
        this.flushOutputBuffer(terminal);
      } else if (!terminal.outputFlushTimer) {
        // Schedule flush for next frame. Hidden panels use a slower cadence
        // to cut main-process IPC wake-ups; foreground panels keep 32 ms.
        const interval = terminal.isVisible
          ? OUTPUT_BATCH_INTERVAL
          : OUTPUT_BATCH_INTERVAL_HIDDEN;
        terminal.outputFlushTimer = setTimeout(() => {
          this.flushOutputBuffer(terminal);
        }, interval);
      }
    });
    
    // Handle terminal exit
    terminal.pty.onExit((exitCode: { exitCode: number; signal?: number }) => {
      // Clear idle timer and mark as idle on exit
      if (terminal.idleTimer) {
        clearTimeout(terminal.idleTimer);
        terminal.idleTimer = null;
      }
      if (terminal.activityStatus !== 'idle') {
        terminal.activityStatus = 'idle';
        this.emitActivityStatus(terminal);
      }

      // Emit exit event
      panelManager.emitPanelEvent(
        terminal.panelId,
        'terminal:exit',
        {
          exitCode: exitCode.exitCode,
          signal: exitCode.signal,
          timestamp: new Date().toISOString()
        }
      );

      // Clean up
      this.terminals.delete(terminal.panelId);

      // Notify frontend (include signal for crash detection)
      if (mainWindow) {
        mainWindow.webContents.send('terminal:exited', {
          sessionId: terminal.sessionId,
          panelId: terminal.panelId,
          exitCode: exitCode.exitCode,
          signal: exitCode.signal ?? null
        });
      }
    });
  }
  
  private addToScrollback(terminal: TerminalProcess, data: string): void {
    if (terminal.isAlternateScreen) {
      terminal.alternateScreenBuffer = this.trimAnsiSafe(
        terminal.alternateScreenBuffer + data,
        MAX_ALTERNATE_SCREEN_BUFFER_SIZE
      );
      return;
    }

    terminal.scrollbackBuffer = this.trimAnsiSafe(
      terminal.scrollbackBuffer + data,
      MAX_SCROLLBACK_BUFFER_SIZE
    );
  }
  
  private isFileOperationCommand(command: string): boolean {
    const fileOperations = [
      'touch', 'rm', 'mv', 'cp', 'mkdir', 'rmdir',
      'cat >', 'echo >', 'echo >>', 'vim', 'vi', 'nano', 'emacs',
      'git add', 'git rm', 'git mv'
    ];
    
    const trimmedCommand = command.trim().toLowerCase();
    return fileOperations.some(op => trimmedCommand.startsWith(op));
  }
  
  isTerminalInitialized(panelId: string): boolean {
    return this.terminals.has(panelId);
  }
  
  writeToTerminal(panelId: string, data: string): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) {
      console.warn(`[TerminalPanelManager] Terminal ${panelId} not found`);
      return;
    }

    try {
      terminal.pty.write(data);
    } catch (err) {
      // PTY may have exited between the map lookup and the write call
      console.warn(`[TerminalPanelManager] Failed to write to terminal ${panelId}:`, err);
      this.terminals.delete(panelId);
      return;
    }
    terminal.lastActivity = new Date();
  }
  
  resizeTerminal(panelId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) {
      console.warn(`[TerminalPanelManager] Terminal ${panelId} not found for resize`);
      return;
    }

    // Reject unreasonably small dimensions (likely from hidden container)
    if (cols < 20 || rows < 5) {
      console.warn(`[TerminalPanelManager] Rejecting invalid resize ${cols}x${rows} for ${panelId}`);
      return;
    }

    try {
      terminal.pty.resize(cols, rows);
    } catch (err) {
      // PTY may have exited between the map lookup and the resize call
      console.warn(`[TerminalPanelManager] Failed to resize terminal ${panelId}:`, err);
      this.terminals.delete(panelId);
      return;
    }
    
    // Update panel state with new dimensions
    const panel = panelManager.getPanel(panelId);
    if (panel) {
      const state = panel.state;
      state.customState = {
        ...state.customState,
        dimensions: { cols, rows }
      } as TerminalPanelState;
      panelManager.updatePanel(panelId, { state });
    }
  }
  
  async saveTerminalState(panelId: string): Promise<void> {
    const terminal = this.terminals.get(panelId);
    if (!terminal) {
      console.warn(`[TerminalPanelManager] Terminal ${panelId} not found for state save`);
      return;
    }
    
    const panel = panelManager.getPanel(panelId);
    if (!panel) return;
    
    // Get current working directory (if possible)
    let cwd = (panel.state.customState && 'cwd' in panel.state.customState) ? panel.state.customState.cwd : undefined;
    cwd = cwd || process.cwd();
    try {
      // Try to get CWD from process (platform-specific)
      if (process.platform !== 'win32') {
        const pid = terminal.pty.pid;
        if (pid) {
          // This is a simplified approach - in production you might use platform-specific methods
          cwd = await this.getProcessCwd(pid);
        }
      }
    } catch (error) {
      console.warn(`[TerminalPanelManager] Could not get CWD for terminal ${panelId}:`, error);
    }
    
    // Save state to panel
    const state = panel.state;
    state.customState = {
      ...state.customState,
      isInitialized: true,
      cwd: cwd,
      scrollbackBuffer: terminal.scrollbackBuffer,
      alternateScreenBuffer: terminal.alternateScreenBuffer,
      isAlternateScreen: terminal.isAlternateScreen,
      commandHistory: terminal.commandHistory.slice(-100), // Keep last 100 commands
      lastActivityTime: terminal.lastActivity.toISOString(),
      lastActiveCommand: terminal.currentCommand,
      serializedBuffer: this.serializedBuffers.get(panelId)
    } as TerminalPanelState;
    
    await panelManager.updatePanel(panelId, { state });
    
  }
  
  private async getProcessCwd(pid: number): Promise<string> {
    // This is platform-specific and simplified
    // In production, you'd use more robust methods
    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        const fs = require('fs').promises;
        const cwdLink = `/proc/${pid}/cwd`;
        return await fs.readlink(cwdLink);
      } catch {
        return process.cwd();
      }
    }
    return process.cwd();
  }
  
  async restoreTerminalState(panel: ToolPanel, state: TerminalPanelState, wslContext?: WSLContext | null): Promise<void> {
    if (!state.scrollbackBuffer || state.scrollbackBuffer.length === 0) {
      return;
    }

    // Initialize terminal first
    await this.initializeTerminal(panel, state.cwd || process.cwd(), wslContext);
    
    const terminal = this.terminals.get(panel.id);
    if (!terminal) return;
    
    // Restore scrollback buffer (handle both string and array formats)
    if (typeof state.scrollbackBuffer === 'string') {
      terminal.scrollbackBuffer = state.scrollbackBuffer;
    } else if (Array.isArray(state.scrollbackBuffer)) {
      // Convert legacy array format to string
      terminal.scrollbackBuffer = state.scrollbackBuffer.join('\n');
    } else {
      terminal.scrollbackBuffer = '';
    }
    terminal.alternateScreenBuffer = state.alternateScreenBuffer || '';
    terminal.commandHistory = state.commandHistory || [];
    
    // Send restoration indicator to terminal
    const restorationMsg = `\r\n[Session Restored from ${state.lastActivityTime || 'previous session'}]\r\n`;
    terminal.pty.write(restorationMsg);
    
    // Send scrollback to frontend. Dual-path mirrors `flushOutputBuffer`:
    // `terminal:output` IPC for legacy subscribers, ptyHost port for flag-on.
    if (mainWindow && state.scrollbackBuffer) {
      const output = typeof state.scrollbackBuffer === 'string'
        ? state.scrollbackBuffer + restorationMsg
        : state.scrollbackBuffer.join('\n') + restorationMsg;
      mainWindow.webContents.send('terminal:output', {
        sessionId: panel.sessionId,
        panelId: panel.id,
        output,
      });
      if (terminal.isPtyHost && terminal.ptyId) {
        const supervisor = getPtyHostSupervisor();
        supervisor?.postDataToRenderers(terminal.ptyId, output);
      }
    }
  }
  
  getTerminalState(panelId: string): TerminalPanelState | null {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return null;
    
    return {
      isInitialized: true,
      cwd: process.cwd(), // Simplified - would need platform-specific implementation
      shellType: process.env.SHELL || 'bash',
      scrollbackBuffer: terminal.scrollbackBuffer,
      alternateScreenBuffer: terminal.alternateScreenBuffer,
      isAlternateScreen: terminal.isAlternateScreen,
      commandHistory: terminal.commandHistory,
      lastActivityTime: terminal.lastActivity.toISOString(),
      lastActiveCommand: terminal.currentCommand,
      serializedBuffer: this.serializedBuffers.get(panelId)
    };
  }
  
  private emitActivityStatus(terminal: TerminalProcess): void {
    if (mainWindow) {
      mainWindow.webContents.send('panel:activityStatus', {
        panelId: terminal.panelId,
        sessionId: terminal.sessionId,
        status: terminal.activityStatus,
        lastActivityAt: terminal.lastActivity.toISOString()
      });
    }
  }

  destroyTerminal(panelId: string): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) {
      return;
    }

    // Save state before destroying
    this.saveTerminalState(panelId);

    // Clear timers
    if (terminal.outputFlushTimer) {
      clearTimeout(terminal.outputFlushTimer);
      terminal.outputFlushTimer = null;
    }
    disposeFlowControlRecord(terminal.flowControl);
    if (terminal.idleTimer) {
      clearTimeout(terminal.idleTimer);
      terminal.idleTimer = null;
    }
    this.flushOutputBuffer(terminal);

    // Kill the PTY process
    try {
      if (terminal.isWSL) {
        terminal.pty.write('exit\r');
        // Give WSL a moment to gracefully exit
        setTimeout(() => {
          try { terminal.pty.kill(); } catch { /* already exited */ }
        }, 500);
      } else {
        terminal.pty.kill();
      }
    } catch (error) {
      console.error(`[TerminalPanelManager] Error killing terminal ${panelId}:`, error);
    }

    // Remove from maps
    this.terminals.delete(panelId);
    this.serializedBuffers.delete(panelId);
  }

  /**
   * Get all active terminal panel IDs.
   */
  getAllPanelIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Send Ctrl+C to all running terminals (for graceful shutdown).
   * Returns array of panel IDs that were signaled.
   */
  sendCtrlCToAll(): string[] {
    const signaledPanels: string[] = [];

    for (const [panelId, terminal] of this.terminals) {
      try {
        terminal.pty.write('\x03');
        signaledPanels.push(panelId);
        console.log(`[TerminalPanelManager] Sent Ctrl+C to terminal panel ${panelId}`);
      } catch (error) {
        console.error(`[TerminalPanelManager] Error sending Ctrl+C to terminal ${panelId}:`, error);
      }
    }

    return signaledPanels;
  }

  /**
   * Save state for all running terminals.
   */
  async saveAllTerminalStates(): Promise<void> {
    for (const panelId of this.terminals.keys()) {
      await this.saveTerminalState(panelId);
    }
  }

  /**
   * Re-spawn every live terminal panel after a ptyHost `UtilityProcess` restart.
   *
   * Order in the supervisor (see `ptyHostSupervisor.onProcExit`):
   *   rejectPendingRpcs → keep manager maps → await nextReady → respawnAll
   *
   * The supervisor intentionally does not emit synthetic exits on host crash:
   * doing so would run `setupTerminalHandlers.onExit` and delete the state this
   * method needs to respawn. Entries here reference stale `PtyHandleShim`s and
   * are replaced in-place.
   *
   * Skip rules:
   * - Legacy (non-ptyHost) terminals: supervisor restart is irrelevant to them.
   *   Their underlying `pty.IPty` is still alive; do not touch.
   * - Panels where spawn never finished (`ptyId` absent): no live PTY to revive.
   *
   * Plan Task 6b: run per-panel respawns in parallel via Promise.all.
   */
  async respawnAll(): Promise<void> {
    // Snapshot entries up-front so we can mutate `this.terminals` (delete
    // stale shims) while iterating without affecting the working set.
    const snapshots: Array<{
      panelId: string;
      sessionId: string;
      panel: ToolPanel;
      cwd: string;
      dimensions: { cols: number; rows: number };
      wslContext: WSLContext | null;
    }> = [];

    for (const [panelId, terminal] of this.terminals) {
      // Only ptyHost-backed terminals participate in supervisor restart.
      // Legacy `pty.spawn` processes survive the ptyHost crash untouched.
      if (!terminal.isPtyHost || !terminal.ptyId) {
        continue;
      }

      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        console.warn(`[ptyHost] respawnAll: panel ${panelId} no longer exists, skipping`);
        this.terminals.delete(panelId);
        continue;
      }

      // Read state for respawn: cwd is persisted on panel state by
      // `initializeTerminal` (see lines 616-622). Dimensions likewise.
      const cs = (panel.state.customState || {}) as TerminalPanelState;
      const cwd = cs.cwd || process.cwd();
      const dimensions = cs.dimensions || { cols: 80, rows: 30 };

      snapshots.push({
        panelId,
        sessionId: terminal.sessionId,
        panel,
        cwd,
        dimensions,
        // Carry the original wslContext through so WSL panels get the same
        // WSLENV / distro / user propagation on respawn. Without this, WSL
        // terminals lose GIT_COMMITTER_* and PANE_* after a supervisor restart.
        wslContext: terminal.wslContext,
      });

      // Clear the stale entry so `initializeTerminal`'s duplicate-check at
      // `:304` doesn't early-return on the stub we're replacing.
      // We also clear any active timers on the stale entry to prevent
      // zombie callbacks firing against the new process.
      if (terminal.outputFlushTimer) {
        clearTimeout(terminal.outputFlushTimer);
        terminal.outputFlushTimer = null;
      }
      disposeFlowControlRecord(terminal.flowControl);
      if (terminal.idleTimer) {
        clearTimeout(terminal.idleTimer);
        terminal.idleTimer = null;
      }
      this.terminals.delete(panelId);
    }

    if (snapshots.length === 0) {
      console.log('[ptyHost] TerminalPanelManager respawnAll: no ptyHost-backed panels to restart');
      return;
    }

    console.log(`[ptyHost] TerminalPanelManager respawnAll: ${snapshots.length} terminal panels`);

    // Run respawns in parallel. Individual failures don't cancel siblings.
    // wslContext is the one captured at original spawn time (Option A); see
    // snapshot construction above.
    const results = await Promise.all(snapshots.map(async ({ panel, cwd, dimensions, panelId, wslContext }) => {
      try {
        await this.initializeTerminal(panel, cwd, wslContext, 1, dimensions);
        return { panelId, ok: true as const };
      } catch (err) {
        console.error(`[ptyHost] respawnAll: initializeTerminal failed for panel ${panelId}:`, err);
        return { panelId, ok: false as const };
      }
    }));

    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    console.log(`[ptyHost] respawn complete: ${ok} terminal panels (${failed} failed)`);
  }

  /**
   * Get scrollback buffer for a specific terminal.
   * Returns null if terminal not found.
   */
  getTerminalScrollback(panelId: string): string | null {
    return this.terminals.get(panelId)?.scrollbackBuffer ?? null;
  }

  /**
   * Returns the alternate screen buffer state for a terminal panel.
   * Used by the renderer to initialize TUI detection when a panel
   * remounts while a full-screen program is already running.
   */
  getAltScreenState(panelId: string): { isAlternateScreen: boolean } | null {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return null;
    return { isAlternateScreen: terminal.isAlternateScreen };
  }

  saveSerializedSnapshot(panelId: string, serializedData: string): void {
    // Enforce 8MB per-snapshot limit
    const MAX_SNAPSHOT_SIZE = 8_000_000;
    if (serializedData.length > MAX_SNAPSHOT_SIZE) {
      console.warn(`[TerminalPanelManager] Serialized snapshot for ${panelId} exceeds 8MB limit (${(serializedData.length / 1_000_000).toFixed(1)}MB), skipping`);
      return;
    }

    this.serializedBuffers.set(panelId, serializedData);

    // Enforce 64MB total limit across all panels
    const MAX_TOTAL_SIZE = 64_000_000;
    let totalSize = 0;
    for (const [, data] of this.serializedBuffers) {
      totalSize += data.length;
    }

    if (totalSize > MAX_TOTAL_SIZE) {
      // Prune oldest entries until under limit
      // Use terminal lastActivity to determine age
      const entries = Array.from(this.serializedBuffers.entries());
      // Sort by terminal activity time (oldest first) using the terminals map
      entries.sort((a, b) => {
        const termA = this.terminals.get(a[0]);
        const termB = this.terminals.get(b[0]);
        const timeA = termA?.lastActivity?.getTime() ?? 0;
        const timeB = termB?.lastActivity?.getTime() ?? 0;
        return timeA - timeB;
      });

      for (const [id] of entries) {
        if (totalSize <= MAX_TOTAL_SIZE) break;
        if (id === panelId) continue; // Don't prune the one we just added
        const removed = this.serializedBuffers.get(id);
        if (removed) {
          totalSize -= removed.length;
          this.serializedBuffers.delete(id);
          console.log(`[TerminalPanelManager] Pruned serialized snapshot for ${id} to stay under 64MB total`);
        }
      }
    }
  }

  destroyAllTerminals(): void {
    for (const [panelId, terminal] of this.terminals) {
      try {
        // Save state before killing
        this.saveTerminalState(panelId);

        // Clear timers
        if (terminal.outputFlushTimer) {
          clearTimeout(terminal.outputFlushTimer);
          terminal.outputFlushTimer = null;
        }
        disposeFlowControlRecord(terminal.flowControl);
        if (terminal.idleTimer) {
          clearTimeout(terminal.idleTimer);
          terminal.idleTimer = null;
        }
        this.flushOutputBuffer(terminal);

        terminal.pty.kill();
      } catch (error) {
        console.error(`[TerminalPanelManager] Error killing terminal ${panelId}:`, error);
      }
    }

    this.terminals.clear();
    this.serializedBuffers.clear();
  }

  getActiveTerminals(): string[] {
    return Array.from(this.terminals.keys());
  }
}

// Export singleton instance
export const terminalPanelManager = new TerminalPanelManager();
