import type { DiffRequestErrorCode, DiffScope, FileDiffRequest } from '../../../shared/types/gitDiff';
import { BoundaryDecodeError, boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { DiffRequestError } from '../services/gitDiffManager';
import type { AppServices } from './types';

export const diffScopeSchema = boundary.union(
  boundary.object({ kind: boundary.literal('session') }),
  boundary.object({ kind: boundary.literal('commit'), hash: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.literal('working-tree') }),
  boundary.object({ kind: boundary.literal('commit-range'), olderHash: boundary.nonEmptyString, newerHash: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.literal('working-tree-range'), baseHash: boundary.nonEmptyString }),
);

export const fileDiffRequestSchema = boundary.object({
  path: boundary.nonEmptyString,
  previousPath: boundary.optional(boundary.nonEmptyString),
});

export function isHexHash(value: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(value);
}

function validateScopeHashes(scope: DiffScope): void {
  const hashes = scope.kind === 'commit' ? [scope.hash]
    : scope.kind === 'commit-range' ? [scope.olderHash, scope.newerHash]
      : scope.kind === 'working-tree-range' ? [scope.baseHash]
        : [];
  if (!hashes.every(isHexHash)) throw new DiffRequestError('unknown-commit', 'Scope contains an invalid commit hash');
}

interface DiffErrorResponse { success: false; error: string; code: DiffRequestErrorCode }

function responseError(cause: unknown): DiffErrorResponse {
  if (cause instanceof DiffRequestError) return { success: false, error: cause.message, code: cause.code };
  if (cause instanceof BoundaryDecodeError) return { success: false, error: cause.message, code: 'invalid-scope' };
  return { success: false, error: cause instanceof Error ? cause.message : 'Failed to load diff', code: 'git-error' };
}

export function registerGitDiffRequestHandlers(
  commandRegistry: PaneCommandRegistry,
  services: AppServices,
): void {
  const { sessionManager, worktreeManager, gitDiffManager } = services;
  const loadContext = (sessionId: string) => {
    const session = sessionManager.getSession(sessionId);
    if (!session?.worktreePath) throw new DiffRequestError('session-not-found', 'Session or worktree path not found');
    if (session.archived) throw new DiffRequestError('archived', 'Cannot access git diff for archived session');
    const context = sessionManager.getProjectContext(sessionId);
    if (!context) throw new DiffRequestError('session-not-found', 'Project context not found for session');
    return { session, context };
  };

  commandRegistry.register('sessions:get-diff-manifest', async (sessionId: string, rawScope: PaneCommandValue) => {
    let scopeKind = 'unknown';
    try {
      const scope = decodeBoundary(rawScope, diffScopeSchema);
      scopeKind = scope.kind;
      validateScopeHashes(scope);
      const { session, context } = loadContext(sessionId);
      const data = await gitDiffManager.getDiffManifest(session.worktreePath!, scope, context.commandRunner, {
        comparisonBase: () => worktreeManager.getSessionComparisonBranch(session, context),
      });
      return { success: true, data };
    } catch (cause: unknown) {
      const response = responseError(cause);
      console.warn('[IPC:git-diff] sessions:get-diff-manifest failed', { sessionId, scopeKind, code: response.code });
      return response;
    }
  });

  commandRegistry.register('sessions:get-file-diff', async (sessionId: string, rawScope: PaneCommandValue, rawRequest: PaneCommandValue) => {
    let scopeKind = 'unknown';
    try {
      const scope: DiffScope = decodeBoundary(rawScope, diffScopeSchema);
      scopeKind = scope.kind;
      let request: FileDiffRequest;
      try {
        request = decodeBoundary(rawRequest, fileDiffRequestSchema);
      } catch (cause: unknown) {
        if (cause instanceof BoundaryDecodeError) throw new DiffRequestError('invalid-path', cause.message);
        throw cause;
      }
      validateScopeHashes(scope);
      const { session, context } = loadContext(sessionId);
      const data = await gitDiffManager.getFileDiff(session.worktreePath!, scope, request, context.commandRunner, {
        comparisonBase: () => worktreeManager.getSessionComparisonBranch(session, context),
      });
      return { success: true, data };
    } catch (cause: unknown) {
      const response = responseError(cause);
      console.warn('[IPC:git-diff] sessions:get-file-diff failed', { sessionId, scopeKind, code: response.code });
      return response;
    }
  });
}
