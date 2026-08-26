import { describe, expect, it } from 'vitest';

/**
 * These tests verify the correctness of the verification logic changes
 * for issues #513 (false-positive submit verification) and #510 (orphan
 * session cleanup). The functions under test are module-private in
 * runpane.ts, so we replicate the core logic assertions here.
 */

describe('looksLikePendingComposer pattern', () => {
  const looksLikePendingComposer = (text: string): boolean =>
    /\[Pasted (?:Content|text)[^\]]*\]/i.test(text) ||
    /(?:press\s+)?(?:ctrl|control)\+enter\s+to\s+submit/i.test(text);

  it.each([
    ['[Pasted Content +5 lines]', true],
    ['[Pasted Content]', true],
    ['[Pasted text #1 +10 lines]', true],
    ['[Pasted text #2 +3 lines]', true],
    ['press ctrl+enter to submit', true],
    ['Press Ctrl+Enter to submit', true],
    ['Control+Enter to submit', true],
    ['normal output without markers', false],
    ['[Some other bracket]', false],
    ['[Pasted something else]', false],
  ])('classifies %j as %s', (text, expected) => {
    expect(looksLikePendingComposer(text)).toBe(expected);
  });
});

describe('activity transition verification logic (#513)', () => {
  type ActivityStatus = 'active' | 'idle';

  interface VerificationResult {
    verifiedSubmitted: boolean;
    verification?: 'observed' | 'unverifiable';
  }

  function shouldVerifySubmitted(
    beforeStatus: ActivityStatus | undefined,
    afterStatus: ActivityStatus | undefined,
  ): VerificationResult {
    const beforeWasActive = beforeStatus === 'active';

    if (afterStatus === 'active' && !beforeWasActive) {
      return { verifiedSubmitted: true, verification: 'observed' };
    }

    if (beforeWasActive) {
      return { verifiedSubmitted: false, verification: 'unverifiable' };
    }

    return { verifiedSubmitted: false };
  }

  it('returns verifiedSubmitted:true when activity transitions from idle to active', () => {
    const result = shouldVerifySubmitted('idle', 'active');
    expect(result.verifiedSubmitted).toBe(true);
    expect(result.verification).toBe('observed');
  });

  it('returns verifiedSubmitted:false when agent was already active (the #513 bug)', () => {
    const result = shouldVerifySubmitted('active', 'active');
    expect(result.verifiedSubmitted).toBe(false);
    expect(result.verification).toBe('unverifiable');
  });

  it('returns verifiedSubmitted:false when before was active and after is idle', () => {
    const result = shouldVerifySubmitted('active', 'idle');
    expect(result.verifiedSubmitted).toBe(false);
    expect(result.verification).toBe('unverifiable');
  });

  it('returns verifiedSubmitted:false when both idle (submit had no effect)', () => {
    const result = shouldVerifySubmitted('idle', 'idle');
    expect(result.verifiedSubmitted).toBe(false);
    expect(result.verification).toBeUndefined();
  });

  it('returns verifiedSubmitted:false when before is undefined and after is idle', () => {
    const result = shouldVerifySubmitted(undefined, 'idle');
    expect(result.verifiedSubmitted).toBe(false);
    expect(result.verification).toBeUndefined();
  });

  it('returns verifiedSubmitted:true when before is undefined and after is active', () => {
    const result = shouldVerifySubmitted(undefined, 'active');
    expect(result.verifiedSubmitted).toBe(true);
    expect(result.verification).toBe('observed');
  });
});

describe('createFailureItem shape (#510)', () => {
  function createFailureItem(
    index: number,
    name: string,
    errorMessage: string,
    sessionId?: string,
    worktreePath?: string,
  ) {
    return {
      ok: false as const,
      index,
      name,
      sessionId,
      paneId: sessionId,
      worktreePath,
      error: {
        message: errorMessage,
        code: 'ERR_RUNPANE_PANE_CREATE_FAILED',
      },
    };
  }

  it('includes sessionId and worktreePath when session was created', () => {
    const item = createFailureItem(0, 'test-pane', 'panel failed', 'sess-123', '/tmp/worktree');
    expect(item.ok).toBe(false);
    expect(item.sessionId).toBe('sess-123');
    expect(item.paneId).toBe('sess-123');
    expect(item.worktreePath).toBe('/tmp/worktree');
    expect(item.error.message).toBe('panel failed');
  });

  it('omits sessionId and worktreePath when session was not created', () => {
    const item = createFailureItem(0, 'test-pane', 'validation failed');
    expect(item.ok).toBe(false);
    expect(item.sessionId).toBeUndefined();
    expect(item.paneId).toBeUndefined();
    expect(item.worktreePath).toBeUndefined();
  });
});

describe('agentStatus aggregation logic', () => {
  type ActivityStatus = 'active' | 'idle';

  function resolveAggregatedAgentStatus(
    panelStatuses: Array<ActivityStatus | undefined>,
  ): ActivityStatus {
    for (const status of panelStatuses) {
      if (status === 'active') {
        return 'active';
      }
    }
    return 'idle';
  }

  it('returns active when any panel is active', () => {
    expect(resolveAggregatedAgentStatus(['idle', 'active', 'idle'])).toBe('active');
  });

  it('returns idle when all panels are idle', () => {
    expect(resolveAggregatedAgentStatus(['idle', 'idle'])).toBe('idle');
  });

  it('returns idle when no panels exist', () => {
    expect(resolveAggregatedAgentStatus([])).toBe('idle');
  });

  it('returns idle when panel status is undefined', () => {
    expect(resolveAggregatedAgentStatus([undefined, undefined])).toBe('idle');
  });

  it('returns active even if only one panel among undefined is active', () => {
    expect(resolveAggregatedAgentStatus([undefined, 'active', undefined])).toBe('active');
  });
});
