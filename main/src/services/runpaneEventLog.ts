import { randomUUID } from 'crypto';
import type { ToolPanel } from '../../../shared/types/panels';
import type {
  RunpaneCursorExpiredError,
  RunpanePanelsEventsResponse,
  RunpaneSemanticEvent,
  RunpaneSemanticEventType,
} from '../../../shared/types/runpaneOrchestration';
import { getPaneDaemonEventSink } from '../core/runtime';
import { panelStateSummary } from './runpanePanelState';
import { terminalPanelManager } from './terminalPanelManager';

export const RUNPANE_EVENT_LOG_CAPACITY = 5000;

export class RunpaneEventLog {
  private readonly epoch: string;
  private readonly capacity: number;
  private counter = 0;
  private events: RunpaneSemanticEvent[] = [];

  constructor(capacity = RUNPANE_EVENT_LOG_CAPACITY, epoch = randomUUID()) {
    this.capacity = capacity;
    this.epoch = epoch;
  }

  currentCursor(): string {
    return `${this.epoch}:${this.counter}`;
  }

  earliestCursor(): string {
    return this.events[0]?.cursor ?? `${this.epoch}:0`;
  }

  append(type: RunpaneSemanticEventType, panel: ToolPanel, options: { paneId?: string } = {}): RunpaneSemanticEvent {
    this.counter += 1;
    const cursor = this.currentCursor();
    const event: RunpaneSemanticEvent = {
      id: cursor,
      cursor,
      type,
      at: new Date().toISOString(),
      paneId: options.paneId ?? panel.sessionId,
      panelId: panel.id,
      state: panelStateSummary(
        panel,
        terminalPanelManager.getTerminalSnapshot(panel.id),
        undefined,
        terminalPanelManager.getLastKnownBlocker(panel.id),
      ),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    getPaneDaemonEventSink().send('panel:semanticEvent', event);
    return event;
  }

  replaySince(cursor: string): RunpanePanelsEventsResponse {
    const parsed = this.parseCursor(cursor);
    const oldest = this.events.length > 0 ? this.cursorNumber(this.events[0].cursor) : 0;
    if (!parsed || parsed.epoch !== this.epoch || parsed.n > this.counter || (this.events.length > 0 && parsed.n < oldest - 1)) {
      return { ok: false, error: this.cursorExpired() };
    }
    return {
      ok: true,
      events: this.events.filter((event) => this.cursorNumber(event.cursor) > parsed.n),
      cursor: this.currentCursor(),
    };
  }

  panelIdsChangedSince(cursor: string): Set<string> | null {
    const replay = this.replaySince(cursor);
    return replay.ok ? new Set(replay.events.map(event => event.panelId)) : null;
  }

  private parseCursor(cursor: string): { epoch: string; n: number } | null {
    const separator = cursor.lastIndexOf(':');
    if (separator <= 0) return null;
    const epoch = cursor.slice(0, separator);
    const raw = cursor.slice(separator + 1);
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? { epoch, n } : null;
  }

  private cursorNumber(cursor: string): number {
    return Number(cursor.slice(cursor.lastIndexOf(':') + 1));
  }

  private cursorExpired(): RunpaneCursorExpiredError {
    return {
      code: 'cursor_expired',
      earliestCursor: this.earliestCursor(),
      reconcileCommand: 'runpane panels screen --panel <panel-id> --json',
    };
  }
}
