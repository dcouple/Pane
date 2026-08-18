interface PendingViewCommit {
  sessionId: string;
  commitHash: string;
}

let pendingViewCommit: PendingViewCommit | null = null;

/** Called by SessionView before dispatching 'diff:view-commit'. */
export function setPendingViewCommit(sessionId: string, commitHash: string): void {
  pendingViewCommit = { sessionId, commitHash };
}

export function takePendingViewCommit(sessionId: string): string | null {
  if (pendingViewCommit?.sessionId !== sessionId) return null;
  const { commitHash } = pendingViewCommit;
  pendingViewCommit = null;
  return commitHash;
}

export function clearPendingViewCommit(): void {
  pendingViewCommit = null;
}
