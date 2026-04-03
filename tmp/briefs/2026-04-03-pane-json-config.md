# Brief: pane.json and multi-tool config file detection

## Why
Pane's project configuration is entirely database-driven. If someone clones a repo that a teammate set up in Pane, they get none of the project config (scripts, setup commands, etc.). A `pane.json` file at the repo root would let teams share workspace configuration via git — the same problem conductor.json solves for Conductor.build.

Additionally, Pane should be tool-agnostic: if a repo already has a `conductor.json`, `.gitpod.yml`, or `devcontainer.json`, Pane should detect and use those scripts automatically — the same way it detects `pnpm-lock.yaml` vs `package-lock.json` vs `yarn.lock` for package managers.

## Context

### Pane's current project config system
- All project settings stored in SQLite `projects` table: `build_script`, `run_script`, `system_prompt`, `main_branch`, `worktree_folder`, `open_ide_command`, etc.
- Run commands parsed into `project_run_commands` table for UI ordering
- Global app config in `~/.pane/config.json` (watched by `ConfigManager`)
- No repo-root config file detection exists today
- Existing file detection pattern: `worktreeFileSyncService.ts` → `detectInstallCommand()` checks lock files in priority order using `existsAt()` — cross-platform, WSL-aware

### conductor.json schema (the model we're following)
```json
{
  "scripts": {
    "setup": "npm install",
    "run": "npm run dev",
    "archive": "npm run cleanup"
  },
  "runScriptMode": "concurrent" | "nonconcurrent"
}
```
- Committed to git, shared with team
- Personal UI settings **fully override** the file (no per-field merge)
- Scripts run in zsh, with injected env vars (`CONDUCTOR_PORT`, `CONDUCTOR_WORKSPACE_PATH`, etc.)

### Other tools' config files to detect (priority order)
1. `pane.json` — ours, highest priority
2. `conductor.json` — nearly identical schema, direct mapping
3. `.gitpod.yml` — `tasks[].init` → setup, `tasks[].command` → run
4. `.devcontainer/devcontainer.json` — `postCreateCommand` → setup, `postStartCommand` → run

### Relevant codebase files
- `main/src/services/worktreeFileSyncService.ts` — `detectInstallCommand()`, `existsAt()` patterns
- `main/src/services/cliToolRegistry.ts` — extensible registry with caching
- `main/src/ipc/project.ts` — project CRUD IPC handlers
- `main/src/services/sessionManager.ts` — session creation, `runBuildScript()`
- `main/src/services/taskQueue.ts:357-358` — where build_script is invoked during session creation
- `main/src/services/worktreeManager.ts` — worktree initialization
- `main/src/services/configManager.ts` — `~/.pane/config.json` loading/watching pattern
- `main/src/services/terminalPanelManager.ts` — terminal process spawning
- `main/src/services/panels/cli/AbstractCliManager.ts` — CLI process environment setup
- `frontend/src/components/ProjectSettings.tsx` — project settings UI

## Decisions

- **pane.json is scripts-only** — `scripts.setup`, `scripts.run`, `scripts.archive`, and `runScriptMode`. Matches conductor.json's proven minimal schema. Maps directly to existing `build_script` (setup) and `run_script` (run) database fields. Reasoning: avoids complex per-field merge logic between file and database; the codebase has no layering/precedence system for project settings today, and building one would touch too many files for the initial implementation.

- **Same override rule as Conductor** — if the user has set scripts via the UI (database), the file is ignored entirely. No per-field merge. Reasoning: this is the simplest model and matches what Conductor proved works.

- **Detect multiple tools' config files as fallbacks** — priority order: `pane.json` > `conductor.json` > `.gitpod.yml` > `devcontainer.json`. Parse each into the same normalized shape (`{ setup?, run?, archive?, runScriptMode? }`). Reasoning: Pane is tool-agnostic, same philosophy as detecting pnpm/npm/yarn.

- **Read on project add/activate, not live-watched** — config file detection runs when a project is added or activated. No file watcher. If the file changes, user re-activates or clicks a refresh button. Reasoning: simpler than file watching; the file changes infrequently.

- **Archive script is new functionality** — a cleanup hook that runs before `worktreeManager.removeWorktree()` during session deletion/archival. Reasoning: easy to add (one hook point), and conductor.json already proved the use case.

- **PANE_* environment variables are a follow-up** — injecting `PANE_WORKSPACE_PATH`, `PANE_ROOT_PATH`, `PANE_DEFAULT_BRANCH`, `PANE_PORT` into scripts and terminals is valuable but touches multiple process spawn points. Separate from the config file work.

## Rejected Alternatives

- **Broad pane.json covering systemPrompt, mainBranch, worktreeFolder, openIdeCommand, etc.** — rejected because it requires per-field merge/precedence logic between file and database across 8+ fields, touching IPC handlers, session manager, CLI managers, worktree manager, and frontend settings. The codebase doesn't have this layering today. Can be added later once the scripts-only foundation is proven.

- **Live file watching of pane.json** — rejected because the file changes infrequently and adding a watcher per project adds complexity. Read-on-activate is sufficient.

- **Two-way sync (UI changes update pane.json)** — rejected because it creates git noise and conflicts. The file is authored manually or by tooling, not by Pane's UI.

- **Reading AI instruction files (AGENTS.md, CLAUDE.md, etc.)** — rejected for this scope because these are passed through to the CLI tools (Claude Code, Codex) which already read them natively. Pane as a workspace manager doesn't need to parse them.

## Direction

Implement a config file detection service following the existing `detectInstallCommand()` pattern. On project add/activate, check the repo root for `pane.json` > `conductor.json` > `.gitpod.yml` > `devcontainer.json` in priority order. Parse whichever is found into a normalized scripts shape. Use these as defaults for `build_script` and `run_script` when the user hasn't set custom values in the UI. Add an `archive` script hook before worktree cleanup on session deletion. Keep the schema minimal (scripts + runScriptMode only) matching conductor.json's proven approach.
