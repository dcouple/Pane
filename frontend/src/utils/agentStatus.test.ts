import { describe, expect, it } from 'vitest';
import { rollupAgentDisplayStatus, rollupAgentState, rollupSessionAgentState, toAgentDisplayStatus } from './agentStatus';

describe('rollupSessionAgentState', () => {
  const agentStatus = { p1: 'working', p2: 'idle', p3: 'blocked' } as const;
  const session = { p1: 's1', p2: 's1', p3: 's2' };

  it('rolls up only the panels belonging to the session (no panels map needed)', () => {
    expect(rollupSessionAgentState({ ...agentStatus }, session, 's1')).toBe('working');
    expect(rollupSessionAgentState({ ...agentStatus }, session, 's2')).toBe('blocked');
  });

  it('returns unknown for a session with no tracked panels', () => {
    expect(rollupSessionAgentState({ ...agentStatus }, session, 'nope')).toBe('unknown');
  });

  it('rolls up Pane Chat by its session id', () => {
    const status = { '__pane_chat_terminal__': 'working' } as const;
    const sess = { '__pane_chat_terminal__': '__pane_chat_session__' };
    expect(rollupSessionAgentState({ ...status }, sess, '__pane_chat_session__')).toBe('working');
  });
});

describe('rollupAgentState', () => {
  it('applies precedence blocked > working > idle', () => {
    expect(rollupAgentState(['idle', 'working', 'blocked'])).toBe('blocked');
    expect(rollupAgentState(['idle', 'working'])).toBe('working');
    expect(rollupAgentState(['idle', 'idle'])).toBe('idle');
  });

  it('returns unknown when nothing is tracked', () => {
    expect(rollupAgentState([])).toBe('unknown');
    expect(rollupAgentState([undefined, 'unknown'])).toBe('unknown');
  });
});

describe('toAgentDisplayStatus', () => {
  it('maps unseen idle to done and seen idle to idle', () => {
    expect(toAgentDisplayStatus('idle', true)).toBe('done');
    expect(toAgentDisplayStatus('idle', false)).toBe('idle');
  });

  it('passes blocked and working through unchanged', () => {
    expect(toAgentDisplayStatus('blocked', true)).toBe('blocked');
    expect(toAgentDisplayStatus('working', false)).toBe('working');
  });

  it('treats missing/unknown as unknown', () => {
    expect(toAgentDisplayStatus(undefined, true)).toBe('unknown');
    expect(toAgentDisplayStatus('unknown', false)).toBe('unknown');
  });
});

describe('rollupAgentDisplayStatus', () => {
  it('applies blocked > working > done > idle precedence', () => {
    expect(rollupAgentDisplayStatus(['idle', 'blocked', 'working'])).toBe('blocked');
    expect(rollupAgentDisplayStatus(['idle', 'working', 'done'])).toBe('working');
    expect(rollupAgentDisplayStatus(['idle', 'done'])).toBe('done');
    expect(rollupAgentDisplayStatus(['idle', 'idle'])).toBe('idle');
  });

  it('keeps all-done groups visible as done, and empty groups unknown', () => {
    expect(rollupAgentDisplayStatus(['done', 'done'])).toBe('done');
    expect(rollupAgentDisplayStatus([])).toBe('unknown');
    expect(rollupAgentDisplayStatus(['unknown'])).toBe('unknown');
  });
});
