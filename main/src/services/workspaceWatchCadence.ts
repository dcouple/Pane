import type {
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
} from '../../../shared/types/runpaneOrchestration';

export interface WatchCadenceOptions {
  settleMs: number;
  blockedSettleMs: number;
  minIntervalMs: number;
  emitKinds?: readonly RunpaneWorkspaceEntryKind[];
  /** Identity of the consumer's whole filter; a change discards the instance so held entries never leak scope. */
  filterKey: string;
}

interface PendingEntry {
  entry: RunpaneWorkspaceEntry;
  matureAt: number;
}

/** Kinds that end a settle window for the same panel (the state moved on). */
const SETTLE_CANCELLING_KINDS: ReadonlySet<RunpaneWorkspaceEntryKind> = new Set([
  'agent.busy',
  'agent.blocked',
  'agent.unknown',
  'agent.ready',
  'panel.exited',
]);

/** Kinds that must wake the consumer regardless of the batch interval. */
const URGENT_KINDS: ReadonlySet<RunpaneWorkspaceEntryKind> = new Set(['agent.blocked']);

/** Kinds the cadence must observe for cancellation even when the consumer did not ask for them. */
export const CADENCE_OBSERVED_KINDS: readonly RunpaneWorkspaceEntryKind[] = [
  'agent.busy',
  'agent.blocked',
  'agent.unknown',
  'agent.ready',
  'panel.exited',
  'pane.gone',
];

export function cadenceOptionsEqual(a: WatchCadenceOptions, b: WatchCadenceOptions): boolean {
  return a.settleMs === b.settleMs
    && a.blockedSettleMs === b.blockedSettleMs
    && a.minIntervalMs === b.minIntervalMs
    && a.filterKey === b.filterKey
    && [...a.emitKinds ?? []].sort().join(',') === [...b.emitKinds ?? []].sort().join(',');
}

function idleKey(entry: RunpaneWorkspaceEntry): string {
  return entry.panelId ?? entry.paneId;
}

/**
 * Per-consumer shaping of workspace entries: READY/BLOCKED settle windows that a
 * state change cancels silently, and a minimum flush interval that batches
 * non-urgent lines. BLOCKED bypasses the interval once its settle matures.
 */
export class WatchCadence {
  private readonly pending = new Map<string, PendingEntry>();
  private held: RunpaneWorkspaceEntry[] = [];
  private lastFlushAt = 0;
  private lastIngestedGen = 0;
  private readonly lastIdleCountByPanel = new Map<string, number>();

  constructor(readonly options: WatchCadenceOptions) {}

  /** True when this IDLE step for the panel was already ingested (idle entries share a generation). */
  hasSeenIdle(entry: RunpaneWorkspaceEntry): boolean {
    return entry.kind === 'agent.idle'
      && (entry.idleCount ?? 0) <= (this.lastIdleCountByPanel.get(idleKey(entry)) ?? 0);
  }

  /**
   * Lowest journal generation still pending or held. The durable cursor must stay
   * below it so a consumer that dies (or a discarded cadence) re-reads the entry.
   * IDLE entries carry a synthetic generation and are excluded.
   */
  lowestUnflushedGen(): number | undefined {
    let lowest: number | undefined;
    const consider = (entry: RunpaneWorkspaceEntry) => {
      if (entry.kind === 'agent.idle') return;
      if (lowest === undefined || entry.gen < lowest) lowest = entry.gen;
    };
    for (const pending of this.pending.values()) consider(pending.entry);
    for (const entry of this.held) consider(entry);
    return lowest;
  }

  ingest(entries: readonly RunpaneWorkspaceEntry[], nowMs: number): void {
    for (const entry of entries) {
      if (entry.kind === 'agent.idle') {
        if (this.hasSeenIdle(entry)) continue;
        this.lastIdleCountByPanel.set(idleKey(entry), entry.idleCount ?? 0);
        this.hold(entry);
        continue;
      }
      if (entry.gen <= this.lastIngestedGen) continue;
      this.lastIngestedGen = entry.gen;

      if (entry.kind === 'pane.gone') {
        for (const [panelId, pending] of this.pending) {
          if (pending.entry.paneId === entry.paneId) this.pending.delete(panelId);
        }
      } else if (entry.panelId && SETTLE_CANCELLING_KINDS.has(entry.kind)) {
        this.pending.delete(entry.panelId);
      }
      if (entry.kind !== 'pane.created') this.lastIdleCountByPanel.delete(idleKey(entry));

      const settleMs = entry.kind === 'agent.ready'
        ? this.options.settleMs
        : entry.kind === 'agent.blocked' ? this.options.blockedSettleMs : 0;
      if (settleMs > 0 && entry.panelId) {
        if (this.emits(entry.kind)) {
          this.pending.set(entry.panelId, { entry, matureAt: entryTimeMs(entry, nowMs) + settleMs });
        }
        continue;
      }
      this.hold(entry);
    }
  }

  flush(nowMs: number): RunpaneWorkspaceEntry[] {
    for (const [panelId, pending] of [...this.pending]) {
      if (pending.matureAt > nowMs) continue;
      this.pending.delete(panelId);
      this.held.push({ ...pending.entry, settledMs: Math.max(0, nowMs - entryTimeMs(pending.entry, nowMs)) });
    }
    if (this.held.length === 0) return [];
    const urgent = this.held.some(entry => URGENT_KINDS.has(entry.kind));
    if (!urgent && nowMs < this.lastFlushAt + this.options.minIntervalMs) return [];
    const flushed = this.held;
    this.held = [];
    this.lastFlushAt = nowMs;
    return flushed;
  }

  nextDeadline(nowMs: number): number | undefined {
    const deadlines: number[] = [];
    for (const pending of this.pending.values()) deadlines.push(pending.matureAt);
    if (this.held.length > 0) {
      deadlines.push(this.held.some(entry => URGENT_KINDS.has(entry.kind))
        ? nowMs
        : this.lastFlushAt + this.options.minIntervalMs);
    }
    return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
  }

  private hold(entry: RunpaneWorkspaceEntry): void {
    if (this.emits(entry.kind)) this.held.push(entry);
  }

  private emits(kind: RunpaneWorkspaceEntryKind): boolean {
    return !this.options.emitKinds || this.options.emitKinds.includes(kind);
  }
}

function entryTimeMs(entry: RunpaneWorkspaceEntry, fallback: number): number {
  const parsed = Date.parse(entry.at);
  return Number.isFinite(parsed) ? parsed : fallback;
}
