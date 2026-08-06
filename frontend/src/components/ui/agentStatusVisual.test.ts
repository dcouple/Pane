import { describe, expect, it } from 'vitest';
import { agentStatusVisual } from './agentStatusVisual';

describe('agentStatusVisual', () => {
  it('maps each status to its token, label, and animation', () => {
    expect(agentStatusVisual('blocked')).toEqual({ colorClass: 'bg-status-error', label: 'blocked', animate: true });
    expect(agentStatusVisual('working')).toEqual({ colorClass: 'bg-status-info', label: 'working', animate: true });
    expect(agentStatusVisual('done')).toEqual({ colorClass: 'bg-status-info', label: 'done', animate: false });
    expect(agentStatusVisual('idle')).toEqual({ colorClass: 'bg-status-success', label: 'idle', animate: false });
  });

  it('returns null for unknown so no badge renders', () => {
    expect(agentStatusVisual('unknown')).toBeNull();
  });
});
