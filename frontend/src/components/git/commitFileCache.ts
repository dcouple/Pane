import type { GitCommitFilesResult } from '../../../../shared/types/git';

/**
 * Per-commit file listings are immutable, so they are cached for the lifetime
 * of the renderer. The working tree (`index`) is deliberately never cached —
 * it changes constantly and must always be re-read.
 */
const cache = new Map<string, GitCommitFilesResult>();

const WORKING_TREE_REF = 'index';

function commitFileCacheKey(sessionId: string, commitRef: string): string {
  return `${sessionId}:${commitRef}`;
}

export function readCommitFileCache(sessionId: string, commitRef: string): GitCommitFilesResult | undefined {
  if (commitRef === WORKING_TREE_REF) return undefined;
  return cache.get(commitFileCacheKey(sessionId, commitRef));
}

export function writeCommitFileCache(sessionId: string, commitRef: string, value: GitCommitFilesResult): void {
  if (commitRef === WORKING_TREE_REF) return;
  cache.set(commitFileCacheKey(sessionId, commitRef), value);
}

/** Drop cached listings after a git operation rewrites history. */
export function invalidateCommitFileCache(sessionId?: string): void {
  if (!sessionId) {
    cache.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
