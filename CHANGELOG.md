# Changelog

All notable changes to Pane will be documented in this file.

## [Unreleased]

### Added
- Cursor Agent CLI (`cursor-agent`) as a third built-in agent tool: launch pill/menu entries with `mod+alt+5`, prompt-as-argument delivery, chat pre-creation with resume-after-restart, at-a-glance status detection, RunPane `--agent cursor` support with a doctor fallback probe for `~/.local/bin`, and a Cursor option for the Pane Chat orchestrator. macOS/Linux only; the tool is hidden on Windows.

### Changed
- Custom-command keyboard shortcuts moved from `mod+alt+5..9` to `mod+alt+6..9` to make room for the Cursor slot.

## [1.1.123] - 2026-04-25

### Added
- Explorer right-click actions for file creation, rename, copy, cut, paste, duplicate, path copy, reveal, and delete.
- Inline Explorer rename plus keyboard shortcuts for rename, delete, copy, cut, and paste.
- Drag-and-drop file moves and target-aware external file drops into Explorer folders.

### Changed
- Explorer delete now prefers the OS trash/recycle bin with a permanent-delete fallback.
- Browser tab and Explorer global shortcuts no longer intercept text editing shortcuts while inputs are focused.

## [0.0.1] - 2026-02-19

### Initial Release
- Terminal-first AI code assistant manager
- Multi-session support with Claude Code and Codex
- Git worktree integration for isolated development
- Real-time terminal output with XTerm.js
- Project and session management
- Rich output view with syntax highlighting
