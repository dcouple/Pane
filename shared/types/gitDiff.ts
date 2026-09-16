export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type DiffScope =
  | { kind: 'session' }
  | { kind: 'commit'; hash: string }
  | { kind: 'working-tree' }
  | { kind: 'commit-range'; olderHash: string; newerHash: string }
  | { kind: 'working-tree-range'; baseHash: string };

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unmerged';

export interface ChangedFileSummary {
  path: string;
  previousPath?: string;
  kind: ChangeKind;
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
}

export interface ResolvedDiffEndpoint {
  kind: 'comparison-base' | 'commit' | 'empty-tree' | 'working-tree';
  hash?: string;
  ref?: string;
}

export interface DiffManifest {
  scope: DiffScope;
  files: ChangedFileSummary[];
  resolvedBase: ResolvedDiffEndpoint;
  resolvedTarget: ResolvedDiffEndpoint;
  stats: { additions: number; deletions: number; filesChanged: number };
}

export interface FileDiffRequest {
  path: string;
  previousPath?: string;
}

export interface FileDiffResult {
  file: ChangedFileSummary;
  patch: string;
  status: 'changed' | 'no-longer-changed';
}

export type DiffRequestErrorCode =
  | 'session-not-found'
  | 'archived'
  | 'invalid-scope'
  | 'unknown-commit'
  | 'invalid-path'
  | 'diff-too-large'
  | 'git-error';
