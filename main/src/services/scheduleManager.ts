import { randomUUID } from 'crypto';
import { computeNextRun, isDue, isMissed } from './scheduleCalculator';
import {
  MIN_INTERVAL_MINUTES,
  SCHEDULE_TICK_MS,
  type ScheduledRun,
  type ScheduledRunInput,
} from '../../../shared/types/schedule';
import type { Logger } from '../utils/logger';

/**
 * Runs schedules when they come due.
 *
 * Deliberately dumb about time: one timer, one pass over the table, all the
 * arithmetic in `scheduleCalculator`. A timer per schedule would drift, would
 * need rebuilding on every edit, and would silently do nothing after a laptop
 * sleeps — which is precisely when a nightly run matters.
 */

/** Starts a session; the same call the create dialog makes. */
export type SessionStarter = (input: {
  prompt: string;
  worktreeTemplate: string;
  projectId: number;
  toolType: 'claude' | 'none';
}) => Promise<{ sessionId?: string }>;

/**
 * The storage this needs, named as an interface so tests can supply a plain
 * in-memory one — the scheduling behaviour is the part worth testing, and it
 * has nothing to do with SQLite.
 */
export interface ScheduleStore {
  list(projectId?: number): ScheduledRun[];
  get(id: string): ScheduledRun | null;
  listRunnable(): ScheduledRun[];
  upsert(schedule: ScheduledRun): void;
  delete(id: string): void;
}

export class ScheduleManager {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /**
   * The store is injected rather than reached for: importing the database
   * module loads a native SQLite binding, and a scheduling test has no
   * business doing that.
   */
  constructor(
    private repo: ScheduleStore,
    private startSession: SessionStarter,
    private logger?: Logger,
  ) {}

  /**
   * Begin ticking, once what happened while Pane was closed has been settled.
   */
  start(): void {
    if (this.timer) return;

    try {
      this.reconcileOnStart();
    } catch (error) {
      this.logger?.error('[Schedule] Failed to prime schedules', error instanceof Error ? error : undefined);
    }

    this.timer = setInterval(() => {
      void this.tick().catch(error => {
        this.logger?.error('[Schedule] Tick failed', error instanceof Error ? error : undefined);
      });
    }, SCHEDULE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  list(projectId?: number): ScheduledRun[] {
    return this.repo.list(projectId);
  }

  /** Create or update a schedule; the next run is always recomputed here. */
  save(input: ScheduledRunInput): ScheduledRun {
    const existing = input.id ? this.repo.get(input.id) : null;
    const nowMs = Date.now();

    const schedule: ScheduledRun = {
      id: input.id ?? randomUUID(),
      name: input.name.trim() || 'Scheduled run',
      projectId: input.projectId,
      prompt: input.prompt,
      toolType: input.toolType,
      ...(input.worktreeTemplate ? { worktreeTemplate: input.worktreeTemplate } : {}),
      enabled: input.enabled,
      kind: input.kind,
      ...(input.intervalMinutes !== undefined
        ? { intervalMinutes: Math.max(input.intervalMinutes, MIN_INTERVAL_MINUTES) }
        : {}),
      ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay } : {}),
      ...(input.weekday !== undefined ? { weekday: input.weekday } : {}),
      lastRunAtMs: existing?.lastRunAtMs ?? null,
      lastRunStatus: existing?.lastRunStatus ?? null,
      lastRunError: existing?.lastRunError ?? null,
      lastSessionId: existing?.lastSessionId ?? null,
      nextRunAtMs: null,
      createdAtMs: existing?.createdAtMs ?? nowMs,
    };

    schedule.nextRunAtMs = schedule.enabled
      ? computeNextRun({ ...schedule, lastRunAtMs: schedule.lastRunAtMs }, nowMs)
      : null;

    this.repo.upsert(schedule);
    return schedule;
  }

  delete(id: string): void {
    this.repo.delete(id);
  }

  setEnabled(id: string, enabled: boolean): ScheduledRun | null {
    const schedule = this.repo.get(id);
    if (!schedule) return null;

    schedule.enabled = enabled;
    schedule.nextRunAtMs = enabled
      ? computeNextRun({ ...schedule, lastRunAtMs: schedule.lastRunAtMs }, Date.now())
      : null;
    this.repo.upsert(schedule);
    return schedule;
  }

  /** Run one schedule now, without touching its cadence. */
  async runNow(id: string): Promise<ScheduledRun | null> {
    const schedule = this.repo.get(id);
    if (!schedule) return null;
    return this.execute(schedule, { manual: true });
  }

  /** One pass: start what is due, skip what is too late, keep the rest. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const nowMs = Date.now();
      for (const schedule of this.repo.listRunnable()) {
        if (isDue(schedule, nowMs)) {
          await this.execute(schedule, { manual: false });
        } else if (isMissed(schedule, nowMs)) {
          this.recordMissed(schedule, nowMs);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Settle the schedules Pane slept through, before the first tick looks at them.
   *
   * This used to recompute every enabled schedule's next run from now, which
   * quietly erased the evidence: a stored time in the past was replaced with a
   * future one, so the tick that followed saw nothing overdue and never marked
   * the occurrence skipped. A run that came due two minutes before the app
   * opened — well inside the grace period, and meant to happen — disappeared
   * the same way.
   *
   * So only two things are decided here. A schedule with no next run at all
   * gets one, and one that is late beyond the grace period is written off as
   * missed. Everything else keeps the time it was stored with and the tick
   * decides, which is where that decision belongs.
   */
  private reconcileOnStart(): void {
    const nowMs = Date.now();

    for (const schedule of this.repo.list()) {
      if (!schedule.enabled) continue;

      if (schedule.nextRunAtMs === null) {
        schedule.nextRunAtMs = computeNextRun({ ...schedule, lastRunAtMs: schedule.lastRunAtMs }, nowMs);
        this.repo.upsert(schedule);
        continue;
      }

      if (isMissed(schedule, nowMs)) this.recordMissed(schedule, nowMs);
    }
  }

  /**
   * Write off one occurrence that came and went unattended.
   *
   * One, not one per interval that elapsed: `computeNextRun` counts from now,
   * so a weekend of downtime leaves a single skipped entry rather than a
   * backlog nobody wants run.
   */
  private recordMissed(schedule: ScheduledRun, nowMs: number): void {
    this.logger?.info(`[Schedule] Skipping "${schedule.name}" — it came due while Pane was not running.`);
    schedule.lastRunStatus = 'skipped';
    schedule.lastRunError = 'Came due while Pane was closed';
    schedule.nextRunAtMs = computeNextRun({ ...schedule, lastRunAtMs: nowMs }, nowMs);
    this.repo.upsert(schedule);
  }

  private async execute(schedule: ScheduledRun, options: { manual: boolean }): Promise<ScheduledRun> {
    const startedAtMs = Date.now();

    try {
      const result = await this.startSession({
        prompt: schedule.prompt,
        worktreeTemplate: schedule.worktreeTemplate ?? '',
        projectId: schedule.projectId,
        toolType: schedule.toolType,
      });

      schedule.lastRunStatus = 'ok';
      schedule.lastRunError = null;
      schedule.lastSessionId = result.sessionId ?? null;
      this.logger?.info(`[Schedule] Started "${schedule.name}"`);
    } catch (error) {
      schedule.lastRunStatus = 'failed';
      schedule.lastRunError = error instanceof Error ? error.message : String(error);
      this.logger?.error(`[Schedule] "${schedule.name}" failed to start: ${schedule.lastRunError}`);
    }

    schedule.lastRunAtMs = startedAtMs;
    // A manual run must not shift the cadence: "run now" is not "run at this
    // time from now on".
    if (!options.manual) {
      schedule.nextRunAtMs = schedule.enabled
        ? computeNextRun({ ...schedule, lastRunAtMs: startedAtMs }, startedAtMs)
        : null;
    }

    this.repo.upsert(schedule);
    return schedule;
  }
}
