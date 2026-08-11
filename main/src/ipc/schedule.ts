import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { ScheduleManager } from '../services/scheduleManager';
import { ScheduleRepository } from '../services/scheduleRepository';
import { databaseService } from '../services/database';
import { MIN_INTERVAL_MINUTES, type ScheduledRunInput } from '../../../shared/types/schedule';

export const DAEMON_SCHEDULE_CHANNELS = [
  'schedules:list',
  'schedules:save',
  'schedules:delete',
  'schedules:set-enabled',
  'schedules:run-now',
] as const;

/** Reject a schedule that could never run before it is stored. */
function validate(input: ScheduledRunInput): string | null {
  if (!input) return 'No schedule given';
  if (!input.prompt?.trim()) return 'A prompt is required — it is what the agent starts with';
  if (!Number.isFinite(input.projectId)) return 'A project is required';

  if (input.kind === 'interval') {
    if (!input.intervalMinutes || input.intervalMinutes < MIN_INTERVAL_MINUTES) {
      return `The shortest interval is ${MIN_INTERVAL_MINUTES} minutes`;
    }
    return null;
  }

  if (!/^\d{1,2}:\d{2}$/.test(input.timeOfDay ?? '')) return 'A time of day is required, as HH:MM';
  if (input.kind === 'weekly' && (input.weekday === undefined || input.weekday < 0 || input.weekday > 6)) {
    return 'A weekday is required';
  }
  return null;
}

/**
 * Recurring agent runs.
 *
 * Daemon-owned: a schedule starts a session in a worktree on the machine that
 * runs the agents, and it has to keep firing while no window is open — which is
 * exactly what the daemon is for.
 */
export function registerScheduleHandlers(
  ipcMain: IpcMain,
  { taskQueue }: AppServices,
  commandRegistry: PaneCommandRegistry,
): ScheduleManager {
  const repository = new ScheduleRepository(() => databaseService.getDb());

  const scheduleManager = new ScheduleManager(repository, async input => {
    if (!taskQueue) throw new Error('Task queue not initialised');

    // The same call the create dialog makes, so a scheduled session is
    // indistinguishable from one started by hand — but waiting for the queue,
    // because the job id is not a session id and the schedule list links to
    // the session it produced.
    const result = await taskQueue.createSessionAndWait({
      prompt: input.prompt,
      worktreeTemplate: input.worktreeTemplate,
      projectId: input.projectId,
      toolType: input.toolType,
    });

    return { sessionId: result.sessionId };
  });

  commandRegistry.register('schedules:list', async (projectId?: number) => {
    try {
      const data = scheduleManager.list(
        typeof projectId === 'number' && Number.isFinite(projectId) ? projectId : undefined
      );
      return { success: true, data };
    } catch (error) {
      console.error('[Schedule] Failed to list schedules:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list schedules' };
    }
  });

  commandRegistry.register('schedules:save', async (input: ScheduledRunInput) => {
    try {
      const problem = validate(input);
      if (problem) return { success: false, error: problem };
      return { success: true, data: scheduleManager.save(input) };
    } catch (error) {
      console.error('[Schedule] Failed to save schedule:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save the schedule' };
    }
  });

  commandRegistry.register('schedules:delete', async (id: string) => {
    try {
      scheduleManager.delete(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete the schedule' };
    }
  });

  commandRegistry.register('schedules:set-enabled', async (id: string, enabled: boolean) => {
    try {
      const data = scheduleManager.setEnabled(id, Boolean(enabled));
      if (!data) return { success: false, error: 'Schedule not found' };
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update the schedule' };
    }
  });

  commandRegistry.register('schedules:run-now', async (id: string) => {
    try {
      const data = await scheduleManager.runNow(id);
      if (!data) return { success: false, error: 'Schedule not found' };
      if (data.lastRunStatus === 'failed') {
        return { success: false, error: data.lastRunError ?? 'The run failed to start' };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start the run' };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_SCHEDULE_CHANNELS);

  return scheduleManager;
}
