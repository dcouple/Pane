import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPendingViewCommit,
  setPendingViewCommit,
  takePendingViewCommit,
} from './pendingViewCommit';

describe('pendingViewCommit', () => {
  afterEach(() => clearPendingViewCommit());

  it('retains a commit until the matching session consumes it', () => {
    setPendingViewCommit('session-a', 'abc123');

    expect(takePendingViewCommit('session-b')).toBeNull();
    expect(takePendingViewCommit('session-a')).toBe('abc123');
    expect(takePendingViewCommit('session-a')).toBeNull();
  });

  it('replaces an older pending commit', () => {
    setPendingViewCommit('session-a', 'abc123');
    setPendingViewCommit('session-b', 'def456');

    expect(takePendingViewCommit('session-a')).toBeNull();
    expect(takePendingViewCommit('session-b')).toBe('def456');
  });
});
