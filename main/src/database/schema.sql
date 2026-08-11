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

-- Incremental scan cursor for agent CLI transcript files. Pane reads these
-- read-only. offset_bytes lets a re-scan resume instead of re-reading the file.
-- NOTE this file is split on the statement separator at startup, so a comment
-- must never contain one.
CREATE TABLE IF NOT EXISTS usage_files (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  offset_bytes INTEGER NOT NULL DEFAULT 0,
  last_scanned_ms INTEGER NOT NULL,
  parser_version INTEGER NOT NULL DEFAULT 0
);

-- One row per assistant message with token accounting, normalised across
-- providers. id is the provider message id when available, else path:offset.
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  agent_session_id TEXT,
  cwd TEXT,
  source_path TEXT NOT NULL
);

-- Quota state as the provider itself reported it, newest sample per limit.
-- Codex writes this into every token_count event. Claude reports nothing.
CREATE TABLE IF NOT EXISTS usage_rate_limits (
  provider TEXT NOT NULL,
  limit_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  used_percent REAL NOT NULL,
  window_minutes INTEGER,
  resets_at_ms INTEGER,
  plan_type TEXT,
  captured_at_ms INTEGER NOT NULL,
  PRIMARY KEY (provider, limit_id, scope)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_usage_events_model_ts ON usage_events(model, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_usage_events_source ON usage_events(source_path);
CREATE INDEX IF NOT EXISTS idx_session_outputs_session_id ON session_outputs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_outputs_timestamp ON session_outputs(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_id ON conversation_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_session_git_status_cache_updated_at ON session_git_status_cache(updated_at);
