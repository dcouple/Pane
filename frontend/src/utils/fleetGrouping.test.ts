import { describe, it, expect } from 'vitest';
import { groupFleetTiles, compareFleetTiles, describeFleetTile } from './fleetGrouping';
import type { FleetTileModel } from '../../../shared/types/fleet';
import type { AgentState } from '../../../shared/types/agentStatus';

function tile(overrides: Partial<FleetTileModel> & { panelId: string }): FleetTileModel {
  return {
    sessionId: `session-${overrides.panelId}`,
    sessionName: 'Session',
    sessionArchived: false,
    projectId: 1,
    projectName: 'Alpha',
    worktreePath: '/repo/alpha',
    worktreeName: 'alpha',
    panelTitle: 'Terminal',
    agentType: 'claude',
    isLive: true,
    agentState: 'idle' as AgentState,
    snapshot: null,
    ...overrides,
  };
}

describe('describeFleetTile', () => {
  it('names each level when they differ', () => {
    expect(describeFleetTile({
      projectName: 'Super Forum',
      sessionName: 'security',
      panelTitle: 'Terminal',
    })).toBe('Super Forum / security / Terminal');
  });

  it('says a repeated name once — Pane Chat is project, session and panel', () => {
    expect(describeFleetTile({
      projectName: 'Pane Chat',
      sessionName: 'Pane Chat',
      panelTitle: 'Pane Chat',
    })).toBe('Pane Chat');
  });

  it('treats a difference in case as a repeat', () => {
    expect(describeFleetTile({
      projectName: 'Pane',
      sessionName: 'pane',
      panelTitle: 'Terminal',
    })).toBe('Pane / Terminal');
  });

  it('skips empty parts rather than leaving stray separators', () => {
    expect(describeFleetTile({
      projectName: '',
      sessionName: 'security',
      panelTitle: '  ',
    })).toBe('security');
  });
});

describe('compareFleetTiles', () => {
  it('puts blocked agents before working, and working before idle', () => {
    const sorted = [
      tile({ panelId: 'c', agentState: 'idle' }),
      tile({ panelId: 'a', agentState: 'blocked' }),
      tile({ panelId: 'd', agentState: 'unknown' }),
      tile({ panelId: 'b', agentState: 'working' }),
    ].sort(compareFleetTiles);

    expect(sorted.map(t => t.panelId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('falls back to project then session name within the same state', () => {
    const sorted = [
      tile({ panelId: '2', projectName: 'Beta', sessionName: 'x' }),
      tile({ panelId: '1', projectName: 'Alpha', sessionName: 'z' }),
      tile({ panelId: '3', projectName: 'Alpha', sessionName: 'a' }),
    ].sort(compareFleetTiles);

    expect(sorted.map(t => t.panelId)).toEqual(['3', '1', '2']);
  });
});

describe('groupFleetTiles', () => {
  it('returns no groups for no tiles', () => {
    expect(groupFleetTiles([], 'project')).toEqual([]);
    expect(groupFleetTiles([], 'none')).toEqual([]);
  });

  it('puts everything in one bucket when grouping is disabled', () => {
    const groups = groupFleetTiles([tile({ panelId: 'a' }), tile({ panelId: 'b' })], 'none');
    expect(groups).toHaveLength(1);
    expect(groups[0].tiles).toHaveLength(2);
  });

  it('groups by project and labels buckets with the project name', () => {
    const groups = groupFleetTiles([
      tile({ panelId: 'a', projectId: 1, projectName: 'Alpha' }),
      tile({ panelId: 'b', projectId: 2, projectName: 'Beta' }),
      tile({ panelId: 'c', projectId: 1, projectName: 'Alpha' }),
    ], 'project');

    expect(groups).toHaveLength(2);
    const alpha = groups.find(g => g.label === 'Alpha');
    expect(alpha?.tiles).toHaveLength(2);
  });

  it('keeps sessions without a project in their own bucket', () => {
    const groups = groupFleetTiles([
      tile({ panelId: 'a', projectId: null, projectName: 'Unknown project' }),
    ], 'project');

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('no-project');
  });

  it('orders groups by their most urgent member', () => {
    const groups = groupFleetTiles([
      tile({ panelId: 'a', projectId: 1, projectName: 'Alpha', agentState: 'idle' }),
      tile({ panelId: 'b', projectId: 2, projectName: 'Beta', agentState: 'blocked' }),
    ], 'project');

    expect(groups.map(g => g.label)).toEqual(['Beta', 'Alpha']);
  });

  it('groups by status with human-readable labels', () => {
    const groups = groupFleetTiles([
      tile({ panelId: 'a', agentState: 'blocked' }),
      tile({ panelId: 'b', agentState: 'working' }),
    ], 'status');

    expect(groups.map(g => g.label)).toEqual(['Needs input', 'Working']);
  });

  it('groups by agent type and buckets unknown agents together', () => {
    const groups = groupFleetTiles([
      tile({ panelId: 'a', agentType: 'claude' }),
      tile({ panelId: 'b', agentType: 'codex' }),
      tile({ panelId: 'c', agentType: null }),
    ], 'agent');

    expect(groups.map(g => g.label).sort()).toEqual(['Claude', 'Codex', 'Other agents']);
  });

  it('does not mutate the input array', () => {
    const tiles = [tile({ panelId: 'b', agentState: 'idle' }), tile({ panelId: 'a', agentState: 'blocked' })];
    const before = tiles.map(t => t.panelId);
    groupFleetTiles(tiles, 'project');
    expect(tiles.map(t => t.panelId)).toEqual(before);
  });
});
