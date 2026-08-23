import type { ScheduledRunInput } from '../../../shared/types/schedule';
import { MIN_INTERVAL_MINUTES } from '../../../shared/types/schedule';
import { parseTimeOfDay } from './scheduleCalculator';

export type ScheduleValidationResult =
  | { success: true; data: ScheduledRunInput }
  | { success: false; error: string };

export function validateScheduledRunInput(value: unknown): ScheduleValidationResult {
  if (typeof value !== 'object' || value === null) {
    return { success: false, error: 'No schedule given' };
  }

  const input = value as Partial<ScheduledRunInput>;
  if (typeof input.name !== 'string') return { success: false, error: 'A name is required' };
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    return { success: false, error: 'A prompt is required because it is what the agent starts with' };
  }
  if (!Number.isInteger(input.projectId) || (input.projectId ?? 0) <= 0) {
    return { success: false, error: 'A project is required' };
  }
  if (input.toolType !== 'claude' && input.toolType !== 'none') {
    return { success: false, error: 'A supported agent is required' };
  }
  if (typeof input.enabled !== 'boolean') return { success: false, error: 'Enabled must be true or false' };
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim())) {
    return { success: false, error: 'Schedule id must be a non-empty string' };
  }
  if (input.worktreeTemplate !== undefined && typeof input.worktreeTemplate !== 'string') {
    return { success: false, error: 'Worktree template must be text' };
  }

  if (input.kind === 'interval') {
    if (!Number.isInteger(input.intervalMinutes) || (input.intervalMinutes ?? 0) < MIN_INTERVAL_MINUTES) {
      return { success: false, error: `The shortest interval is ${MIN_INTERVAL_MINUTES} minutes` };
    }
  } else if (input.kind === 'daily' || input.kind === 'weekly') {
    if (!parseTimeOfDay(input.timeOfDay)) {
      return { success: false, error: 'A valid time of day is required, as HH:MM' };
    }
    if (input.kind === 'weekly' && (!Number.isInteger(input.weekday) || (input.weekday ?? -1) < 0 || (input.weekday ?? 7) > 6)) {
      return { success: false, error: 'A weekday is required' };
    }
  } else {
    return { success: false, error: 'Schedule kind must be interval, daily, or weekly' };
  }

  return { success: true, data: input as ScheduledRunInput };
}
