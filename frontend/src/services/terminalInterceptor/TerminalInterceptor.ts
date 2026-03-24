import type {
  InterceptHandler,
  InterceptResult,
  InterceptorState,
} from './types';

interface TerminalInterceptorOptions {
  onStateChange: (state: InterceptorState) => void;
  onFlush: (data: string) => void;
}

export class TerminalInterceptor {
  private handlers: Map<string, InterceptHandler> = new Map();
  private active: boolean = false;
  private activeHandler: InterceptHandler | null = null;
  private activeTrigger: string | null = null;
  private buffer: string = ''; // printable chars only (trigger + filter text) — flushed on cancel
  private filterBuffer: string = ''; // just the filter text (after trigger)

  private readonly _onStateChange: (state: InterceptorState) => void;
  private readonly _onFlush: (data: string) => void;

  constructor(options: TerminalInterceptorOptions) {
    this._onStateChange = options.onStateChange;
    this._onFlush = options.onFlush;
  }

  registerHandler(trigger: string, handler: InterceptHandler): void {
    this.handlers.set(trigger, handler);
  }

  handleInput(data: string): InterceptResult {
    if (!this.active) {
      const handler = this.handlers.get(data);
      if (handler === undefined) {
        return { consumed: false };
      }

      const activated = handler.onActivate();
      if (!activated) {
        return { consumed: false };
      }

      this.active = true;
      this.activeHandler = handler;
      this.activeTrigger = data;
      this.buffer = data;
      this.filterBuffer = '';
      this.notifyStateChange();
      return { consumed: true };
    }

    // Active: get the action FIRST, before appending to buffer.
    // activeHandler is always non-null when active is true.
    if (this.activeHandler === null) {
      this.deactivate();
      return { consumed: false };
    }
    const action = this.activeHandler.onInput(data, this.filterBuffer);

    switch (action.type) {
      case 'consume':
        // Only buffer printable characters — navigation keys (arrow escape sequences,
        // backspace, etc.) are consumed but NOT added to the buffer, so they won't be
        // flushed to the PTY on cancel.
        if (this.isPrintable(data)) {
          this.buffer += data;
        }
        return { consumed: true };

      case 'cancel': {
        // Flush only the printable text the user typed (trigger + filter chars).
        // Include the cancel character only if it's printable (Space yes, Escape no).
        const cancelCharPrintable = this.isPrintable(data);
        const toFlush = cancelCharPrintable
          ? this.buffer + data
          : this.buffer;
        this.deactivate();
        this._onFlush(toFlush);
        return { consumed: true };
      }

      case 'execute':
        this.deactivate();
        return { consumed: true };

      case 'update':
        if (this.isPrintable(data)) {
          this.buffer += data;
        }
        this.filterBuffer = action.buffer;
        this.notifyStateChange();
        return { consumed: true };
    }
  }

  notifyStateChange(): void {
    this._onStateChange({
      active: this.active,
      triggerChar: this.activeTrigger,
      buffer: this.filterBuffer,
      handlerState: this.activeHandler?.getState() ?? null,
    });
  }

  deactivate(): void {
    if (this.activeHandler !== null) {
      this.activeHandler.onDeactivate();
    }
    this.active = false;
    this.activeHandler = null;
    this.activeTrigger = null;
    this.buffer = '';
    this.filterBuffer = '';
    this.notifyStateChange();
  }

  getState(): InterceptorState {
    return {
      active: this.active,
      triggerChar: this.activeTrigger,
      buffer: this.filterBuffer,
      handlerState: this.activeHandler?.getState() ?? null,
    };
  }

  /** A single printable character (no control chars or escape sequences) */
  private isPrintable(data: string): boolean {
    return data.length === 1 && data >= ' ' && data <= '~';
  }

  dispose(): void {
    if (this.active) {
      this.deactivate();
    }
    this.handlers.clear();
  }
}
