import { describe, expect, it } from 'vitest';
import { dueIdleEntries, nextIdleDeadline, type WorkspaceIdleCandidate } from './workspaceIdleTracker';

const candidate = (overrides: Partial<WorkspaceIdleCandidate> = {}): WorkspaceIdleCandidate => ({
  panelId: 'panel-1',
  paneId: 'pane-1',
  paneName: 'Monitor',
  panelTitle: 'Codex',
  agentType: 'codex',
  agentState: 'idle',
  idleSinceMs: 1_000,
  ...overrides,
});

describe('workspaceIdleTracker', () => {
  it('fires at each crossed interval and carries agent metadata', () => {
    expect(dueIdleEntries([candidate()], { idleAfterMs: 10_000 }, 0, 11_000, 7)).toEqual([
      expect.objectContaining({
        kind: 'agent.idle',
        gen: 7,
        panelId: 'panel-1',
        agentType: 'codex',
        idleMs: 10_000,
        idleCount: 1,
      }),
    ]);
    expect(dueIdleEntries([candidate()], { idleAfterMs: 10_000 }, 11_000, 20_999, 7)).toEqual([]);
    expect(dueIdleEntries([candidate()], { idleAfterMs: 10_000 }, 11_000, 21_000, 7)[0]).toMatchObject({ idleCount: 2 });
  });

  it('ignores non-idle candidates and reports the next deadline', () => {
    expect(dueIdleEntries([candidate({ agentState: 'working' })], { idleAfterMs: 10_000 }, 0, 20_000, 1)).toEqual([]);
    expect(nextIdleDeadline([candidate()], { idleAfterMs: 10_000 }, 11_001)).toBe(21_000);
    expect(nextIdleDeadline([], { idleAfterMs: 10_000 }, 11_001)).toBeUndefined();
  });

  it('backs off IDLE to 30m, 1h, 3h, then daily when requested', () => {
    const minute = 60_000;
    const schedule = { idleAfterMs: 10 * minute, backoff: true };
    const idleSince = candidate({ idleSinceMs: 0 });
    const firedAt = (fromMs: number, toMs: number) => dueIdleEntries([idleSince], schedule, fromMs, toMs, 1)
      .map(entry => [entry.idleCount, entry.idleMs / minute]);
    expect(firedAt(0, 10 * minute)).toEqual([[1, 10]]);
    expect(firedAt(10 * minute, 29 * minute)).toEqual([]);
    expect(firedAt(10 * minute, 30 * minute)).toEqual([[2, 30]]);
    expect(firedAt(30 * minute, 60 * minute)).toEqual([[3, 60]]);
    expect(firedAt(60 * minute, 180 * minute)).toEqual([[4, 180]]);
    expect(firedAt(180 * minute, 26 * 60 * minute)).toEqual([]);
    expect(firedAt(180 * minute, 27 * 60 * minute)).toEqual([[5, 27 * 60]]);
    expect(firedAt(27 * 60 * minute, 51 * 60 * minute)).toEqual([[6, 51 * 60]]);

    expect(nextIdleDeadline([idleSince], schedule, 5 * minute)).toBe(10 * minute);
    expect(nextIdleDeadline([idleSince], schedule, 10 * minute)).toBe(30 * minute);
    expect(nextIdleDeadline([idleSince], schedule, 61 * minute)).toBe(180 * minute);
    expect(nextIdleDeadline([idleSince], schedule, 180 * minute)).toBe(27 * 60 * minute);
    expect(nextIdleDeadline([idleSince], schedule, 30 * 60 * minute)).toBe(51 * 60 * minute);
  });

  it('keeps a custom --idle-after as the first backoff step', () => {
    const minute = 60_000;
    const schedule = { idleAfterMs: minute, backoff: true };
    const idleSince = candidate({ idleSinceMs: 0 });
    expect(dueIdleEntries([idleSince], schedule, 0, minute, 1)[0]).toMatchObject({ idleCount: 1, idleMs: minute });
    expect(nextIdleDeadline([idleSince], schedule, minute)).toBe(30 * minute);
    expect(dueIdleEntries([idleSince], { idleAfterMs: 45 * minute, backoff: true }, 0, 46 * minute, 1)[0]).toMatchObject({ idleMs: 45 * minute });
    expect(nextIdleDeadline([idleSince], { idleAfterMs: 45 * minute, backoff: true }, 46 * minute)).toBe(60 * minute);
  });

  it('emits an already-overdue pane immediately for a first-use window', () => {
    expect(dueIdleEntries([candidate()], { idleAfterMs: 10_000 }, 0, 35_000, 2)[0]).toMatchObject({
      idleCount: 3,
      idleMs: 30_000,
    });
  });
});
