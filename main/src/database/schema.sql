-- Projects table for managing multiple projects
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  system_prompt TEXT,
  run_script TEXT,
  active BOOLEAN NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table to store persistent session data
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initial_prompt TEXT NOT NULL,
  worktree_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_output TEXT,
  exit_code INTEGER,
  pid INTEGER,
  claude_session_id TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  is_favorite BOOLEAN DEFAULT 0,
  favorite_pinned_at DATETIME,
  is_hidden BOOLEAN DEFAULT 0
);

-- Session outputs table to store terminal output history
CREATE TABLE IF NOT EXISTS session_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Conversation messages table to track conversation history
CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Derived git status cache for fast startup rendering.
CREATE TABLE IF NOT EXISTS session_git_status_cache (
  session_id TEXT PRIMARY KEY,
  status_json TEXT NOT NULL,
  last_checked_ms INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Recurring agent runs. Each row creates one session when it comes due. The
-- schedule is three shapes rather than cron syntax, so the UI can state it in
-- a sentence. NOTE this file is split on the statement separator at startup,
-- so a comment must never contain one.
CREATE TABLE IF NOT EXISTS scheduled_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  tool_type TEXT NOT NULL DEFAULT 'claude',
  worktree_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  interval_minutes INTEGER,
  time_of_day TEXT,
  weekday INTEGER,
  last_run_at_ms INTEGER,
  last_run_status TEXT,
  last_run_error TEXT,
  last_session_id TEXT,
  next_run_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_next ON scheduled_runs(enabled, next_run_at_ms);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_session_outputs_session_id ON session_outputs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_outputs_timestamp ON session_outputs(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_id ON conversation_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_session_git_status_cache_updated_at ON session_git_status_cache(updated_at);
