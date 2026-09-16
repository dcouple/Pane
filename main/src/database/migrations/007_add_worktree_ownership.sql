-- Pane-managed worktrees may be deleted by Pane; external worktrees never may be.
ALTER TABLE sessions ADD COLUMN worktree_ownership TEXT NOT NULL DEFAULT 'pane';
CREATE INDEX IF NOT EXISTS idx_sessions_worktree_ownership
  ON sessions(worktree_ownership, project_id);
