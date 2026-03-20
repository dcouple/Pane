import * as pty from '@lydell/node-pty';
import { ToolPanel, TerminalPanelState, PanelEventType } from '../../../shared/types/panels';
import { panelManager } from './panelManager';
import { mainWindow, configManager } from '../index';
import * as os from 'os';
import * as path from 'path';
import { getShellPath } from '../utils/shellPath';
import { ShellDetector } from '../utils/shellDetector';
import type { AnalyticsManager } from './analyticsManager';
import { getWSLShellSpawn, WSLContext } from '../utils/wslUtils';
import { GIT_ATTRIBUTION_ENV } from '../utils/attribution';

const HIGH_WATERMARK = 100_000; // 100KB — pause PTY when pending exceeds this
const LOW_WATERMARK = 10_000;   // 10KB — resume PTY when pending drops below this
const OUTPUT_BATCH_INTERVAL = 32; // ms (~30fps) — wider window reduces TUI flicker
const OUTPUT_BATCH_SIZE = 131072; // 128KB — timer-based flush preferred; size trigger is safety net
const OUTPUT_HARD_LIMIT = 1_048_576; // 1MB — drop oldest data if buffer grows unbounded (renderer frozen)
const PAUSE_SAFETY_TIMEOUT = 5_000; // 5s — auto-resume PTY if no acks arrive (prevents permanent stall)
const MAX_CONCURRENT_SPAWNS = 3;

interface TerminalProcess {
  pty: pty.IPty;
  panelId: string;
  sessionId: string;
  scrollbackBuffer: string;
  commandHistory: string[];
  currentCommand: string;
  lastActivity: Date;
  isWSL?: boolean;
  // Flow control
  pendingBytes: number;
  isPaused: boolean;
  pauseSafetyTimer: ReturnType<typeof setTimeout> | null;
  // Output batching
  outputBuffer: string;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
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

  private flushOutputBuffer(terminal: TerminalProcess): void {
    if (terminal.outputFlushTimer) {
      clearTimeout(terminal.outputFlushTimer);
      terminal.outputFlushTimer = null;
    }

    if (!terminal.outputBuffer) return;

    const data = terminal.outputBuffer;
    terminal.outputBuffer = '';

    // Track pending bytes for flow control
    terminal.pendingBytes += data.length;

    // Send batched output to renderer
    if (mainWindow) {
      mainWindow.webContents.send('terminal:output', {
        sessionId: terminal.sessionId,
        panelId: terminal.panelId,
        output: data
      });
    }

    // Apply backpressure if watermark exceeded
    if (terminal.pendingBytes > HIGH_WATERMARK && !terminal.isPaused) {
      terminal.isPaused = true;
      terminal.pty.pause();

      // Safety valve: auto-resume if no acks arrive (e.g., renderer unmounted)
      if (terminal.pauseSafetyTimer) clearTimeout(terminal.pauseSafetyTimer);
      terminal.pauseSafetyTimer = setTimeout(() => {
        if (terminal.isPaused) {
          terminal.isPaused = false;
          terminal.pendingBytes = 0;
          terminal.pty.resume();
        }
        terminal.pauseSafetyTimer = null;
      }, PAUSE_SAFETY_TIMEOUT);
    }
  }

  acknowledgeBytes(panelId: string, bytesConsumed: number): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return;

    terminal.pendingBytes = Math.max(0, terminal.pendingBytes - bytesConsumed);

    if (terminal.isPaused && terminal.pendingBytes < LOW_WATERMARK) {
      terminal.isPaused = false;
      terminal.pty.resume();
      // Cancel safety timer — normal ack flow is working
      if (terminal.pauseSafetyTimer) {
        clearTimeout(terminal.pauseSafetyTimer);
        terminal.pauseSafetyTimer = null;
      }
    }
  }

  // Reset flow control state - useful for recovering from stuck terminals
  resetFlowControl(panelId: string): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return;

    console.log(`[TerminalPanelManager] Resetting flow control for panel ${panelId}`);

    // Clear any pending safety timer
    if (terminal.pauseSafetyTimer) {
      clearTimeout(terminal.pauseSafetyTimer);
      terminal.pauseSafetyTimer = null;
    }

    // Reset flow control state
    terminal.pendingBytes = 0;

    // Resume PTY if paused
    if (terminal.isPaused) {
      terminal.isPaused = false;
      terminal.pty.resume();
    }
  }

  async initializeTerminal(panel: ToolPanel, cwd: string, wslContext?: WSLContext | null, priority: number = 1): Promise<void> {
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

    // Create PTY process with enhanced environment
    const ptyProcess = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: spawnCwd,
      env: {
        ...process.env,
        ...GIT_ATTRIBUTION_ENV,
        PATH: enhancedPath,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
        WORKTREE_PATH: cwd,
        PANE_SESSION_ID: panel.sessionId,
        PANE_PANEL_ID: panel.id
      }
    });
    
    // Create terminal process object
    const terminalProcess: TerminalProcess = {
      pty: ptyProcess,
      panelId: panel.id,
      sessionId: panel.sessionId,
      scrollbackBuffer: '',
      commandHistory: [],
      currentCommand: '',
      lastActivity: new Date(),
      isWSL: !!(wslContext && process.platform === 'win32'),
      pendingBytes: 0,
      isPaused: false,
      pauseSafetyTimer: null,
      outputBuffer: '',
      outputFlushTimer: null
    };
    
    // Store in map
    this.terminals.set(panel.id, terminalProcess);
    
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
      dimensions: { cols: 80, rows: 30 }
    } as TerminalPanelState;

    await panelManager.updatePanel(panel.id, { state });

    } finally {
      this.releaseSpawnSlot();
    }
  }

  private setupTerminalHandlers(terminal: TerminalProcess): void {
    // Handle terminal output
    terminal.pty.onData((data: string) => {
      // Update last activity
      terminal.lastActivity = new Date();
      
      // Add to scrollback buffer
      this.addToScrollback(terminal, data);
      
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
      terminal.outputBuffer += data;

      // Hard limit: if renderer is frozen and buffer grows unbounded, drop oldest data
      if (terminal.outputBuffer.length > OUTPUT_HARD_LIMIT) {
        terminal.outputBuffer = terminal.outputBuffer.slice(-OUTPUT_BATCH_SIZE);
      }

      if (terminal.outputBuffer.length >= OUTPUT_BATCH_SIZE) {
        // Buffer is large enough — flush immediately
        this.flushOutputBuffer(terminal);
      } else if (!terminal.outputFlushTimer) {
        // Schedule flush for next frame
        terminal.outputFlushTimer = setTimeout(() => {
          this.flushOutputBuffer(terminal);
        }, OUTPUT_BATCH_INTERVAL);
      }
    });
    
    // Handle terminal exit
    terminal.pty.onExit((exitCode: { exitCode: number; signal?: number }) => {
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
      
      // Notify frontend
      if (mainWindow) {
        mainWindow.webContents.send('terminal:exited', {
          sessionId: terminal.sessionId,
          panelId: terminal.panelId,
          exitCode: exitCode.exitCode
        });
      }
    });
  }
  
  private addToScrollback(terminal: TerminalProcess, data: string): void {
    // Add raw data to scrollback buffer
    terminal.scrollbackBuffer += data;
    
    // Trim buffer if it exceeds max size (keep last ~500KB of data)
    const maxBufferSize = 500000; // 500KB
    if (terminal.scrollbackBuffer.length > maxBufferSize) {
      // Keep the most recent data
      terminal.scrollbackBuffer = terminal.scrollbackBuffer.slice(-maxBufferSize);
    }
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
    
    terminal.pty.write(data);
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
    terminal.commandHistory = state.commandHistory || [];
    
    // Send restoration indicator to terminal
    const restorationMsg = `\r\n[Session Restored from ${state.lastActivityTime || 'previous session'}]\r\n`;
    terminal.pty.write(restorationMsg);
    
    // Send scrollback to frontend
    if (mainWindow && state.scrollbackBuffer) {
      mainWindow.webContents.send('terminal:output', {
        sessionId: panel.sessionId,
        panelId: panel.id,
        output: state.scrollbackBuffer + restorationMsg
      });
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
      commandHistory: terminal.commandHistory,
      lastActivityTime: terminal.lastActivity.toISOString(),
      lastActiveCommand: terminal.currentCommand,
      serializedBuffer: this.serializedBuffers.get(panelId)
    };
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
    if (terminal.pauseSafetyTimer) {
      clearTimeout(terminal.pauseSafetyTimer);
      terminal.pauseSafetyTimer = null;
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
   * Get scrollback buffer for a specific terminal.
   * Returns null if terminal not found.
   */
  getTerminalScrollback(panelId: string): string | null {
    return this.terminals.get(panelId)?.scrollbackBuffer ?? null;
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
        if (terminal.pauseSafetyTimer) {
          clearTimeout(terminal.pauseSafetyTimer);
          terminal.pauseSafetyTimer = null;
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
