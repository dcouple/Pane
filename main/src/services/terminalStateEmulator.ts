import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';

const HEADLESS_SCROLLBACK_LINES = 2500;

/**
 * Maintains an xterm-compatible terminal model for state restoration and
 * local-control screen reads. PTY output parsing is asynchronous, so callers
 * that need a coherent snapshot must await waitForIdle first.
 */
export class TerminalStateEmulator {
  private readonly terminal: Terminal;
  private readonly serializeAddon = new SerializeAddon();
  private pendingWrites = 0;
  private idleResolvers: Array<() => void> = [];
  private disposed = false;
  private finalIsAlternateScreen = false;
  private finalSerializedBuffer = '';
  private finalScreenText = '';

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: HEADLESS_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializeAddon);
  }

  write(data: string): void {
    if (!data || this.disposed) return;

    this.pendingWrites += 1;
    this.terminal.write(data, () => {
      if (this.disposed) return;
      this.pendingWrites -= 1;
      if (this.pendingWrites === 0) {
        const resolvers = this.idleResolvers;
        this.idleResolvers = [];
        for (const resolve of resolvers) resolve();
      }
    });
  }

  waitForIdle(): Promise<void> {
    if (this.pendingWrites === 0) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.terminal.resize(cols, rows);
  }

  get isAlternateScreen(): boolean {
    return this.disposed
      ? this.finalIsAlternateScreen
      : this.terminal.buffer.active.type === 'alternate';
  }

  /** Serialize the visible normal buffer and, when active, the alternate buffer. */
  serializeForRestore(): string {
    return this.disposed
      ? this.finalSerializedBuffer
      : this.serializeAddon.serialize({ scrollback: 0 });
  }

  /** Return plain text for the currently visible viewport. */
  getScreenText(): string {
    if (this.disposed) return this.finalScreenText;

    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const end = buffer.viewportY + this.terminal.rows;

    for (let index = buffer.viewportY; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  clearScrollback(): void {
    this.terminal.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.finalIsAlternateScreen = this.isAlternateScreen;
    this.finalSerializedBuffer = this.serializeForRestore();
    this.finalScreenText = this.getScreenText();
    this.disposed = true;
    this.terminal.dispose();
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    this.pendingWrites = 0;
    for (const resolve of resolvers) resolve();
  }
}
