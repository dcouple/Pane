interface PendingViewCommit {
  sessionId: string;
  commitHash: string;
  filePath?: string;
}

let pendingViewCommit: PendingViewCommit | null = null;

/** Called by SessionView before dispatching 'diff:view-commit'. */
export function setPendingViewCommit(sessionId: string, commitHash: string, filePath?: string): void {
  pendingViewCommit = { sessionId, commitHash, filePath };
}

export function takePendingViewCommit(sessionId: string): PendingViewCommit | null {
  if (pendingViewCommit?.sessionId !== sessionId) return null;
  const pending = pendingViewCommit;
  pendingViewCommit = null;
  return pending;
}

export function clearPendingViewCommit(): void {
  pendingViewCommit = null;
}
