export interface ExecutionDiff {
  id: number;
  session_id: string;
  prompt_marker_id?: number;
  prompt_text?: string;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[];
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
  timestamp: string;
  author?: string;
  comparison_branch?: string;
  history_source?: 'remote' | 'local' | 'branch';
  history_limit_reached?: boolean;
}

export type { GitDiffResult } from '../../../shared/types/diff';

export interface FileDiff {
  path: string;
  oldPath: string;
  type: 'added' | 'deleted' | 'modified' | 'renamed';
  isBinary: boolean;
  additions: number;
  deletions: number;
  rawDiff: string;
}

export interface DiffViewerProps {
  files: FileDiff[];
  className?: string;
  sessionId?: string;
  onOpenInEditor?: (filePath: string) => void;
}

export interface ExecutionListProps {
  sessionId: string;
  executions: ExecutionDiff[];
  selectedExecutions: number[];
  onSelectionChange: (selectedIds: number[]) => void;
  onCommit?: () => void;
  onRevert?: (commitHash: string) => void;
  onRestore?: () => void;
  historyLimitReached?: boolean;
  historyLimit?: number;
}

export interface CombinedDiffViewProps {
  sessionId: string;
  selectedExecutions: number[];
  isGitOperationRunning?: boolean;
  isMainRepo?: boolean;
  isVisible?: boolean;
}
