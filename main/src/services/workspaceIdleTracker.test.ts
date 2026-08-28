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
    expect(dueIdleEntries([candidate()], 10_000, 0, 11_000, 7)).toEqual([
      expect.objectContaining({
        kind: 'agent.idle',
        gen: 7,
        panelId: 'panel-1',
        agentType: 'codex',
        idleMs: 10_000,
        idleCount: 1,
      }),
    ]);
    expect(dueIdleEntries([candidate()], 10_000, 11_000, 20_999, 7)).toEqual([]);
    expect(dueIdleEntries([candidate()], 10_000, 11_000, 21_000, 7)[0]).toMatchObject({ idleCount: 2 });
  });

  it('ignores non-idle candidates and reports the next deadline', () => {
    expect(dueIdleEntries([candidate({ agentState: 'working' })], 10_000, 0, 20_000, 1)).toEqual([]);
    expect(nextIdleDeadline([candidate()], 10_000, 11_001)).toBe(21_000);
    expect(nextIdleDeadline([], 10_000, 11_001)).toBeUndefined();
  });

  it('emits an already-overdue pane immediately for a first-use window', () => {
    expect(dueIdleEntries([candidate()], 10_000, 0, 35_000, 2)[0]).toMatchObject({
      idleCount: 3,
      idleMs: 30_000,
    });
  });
});
