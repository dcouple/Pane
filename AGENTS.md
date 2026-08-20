# Repository Guidelines

## Project Structure & Module Organization
- Root `pnpm` workspace with packages: `main/` (Electron main process, TypeScript), `frontend/` (React + Vite), `shared/` (shared types), and `tests/` (Playwright E2E).
- Key paths: `main/src/{services,ipc,utils}/`, `frontend/src/{components,hooks,stores,utils}/`, `main/assets/`, `scripts/`.
- Build artifacts: `frontend/dist/`, `main/dist/`, packaged output `dist-electron/`.
- Pane is an Electron desktop app: the main process owns native integration, CLI processes, git worktrees, and SQLite persistence; the preload bridge exposes IPC to the React renderer.
- When adding or changing CLI integrations, follow `docs/ADDING_NEW_CLI_TOOLS.md` and `docs/IMPLEMENTING_NEW_CLI_AGENTS.md`.

## Build, Test, and Development Commands
- Dev app: `pnpm dev` (spawns frontend + Electron).
- Build all: `pnpm build` (frontend, main, then electron package).
- Package (examples): `pnpm build:mac`, `pnpm build:linux`.
- Lint: `pnpm lint`; Type-check: `pnpm typecheck` (runs per package). The root lint command is the single entry point for blocking Oxlint and Knip checks, residual ESLint, and advisory anti-slop checks.
- Detailed advisory output: `pnpm lint:ox:extra:details`; accessibility scan: `pnpm a11y:scan` (install Chromium once with `pnpm exec playwright install chromium`); opt-in render evidence: `pnpm perf:scan`.
- Tests (E2E): `pnpm test`, `pnpm test:ui`, CI configs in `playwright.ci*.config.ts`.
- Themes: `pnpm theme:contrast` gates the 15 batch themes' token pairs in `frontend/src/styles/tokens/colors.css` (text/UI/terminal contrast, high-contrast overlay, CVD separation; `--all` reports the original twelve, `--themes a,b` picks themes, `--markdown --cvd` prints PR tables — see `scripts/README.md`); `pnpm theme:screenshots` regenerates `screenshots/themes/batch/`.
- Main unit tests: `pnpm --filter main test` (Vitest), coverage: `pnpm --filter main run test:coverage`.
- Frontend unit tests: `pnpm --filter frontend test` (Vitest).
- Releases must follow `docs/RELEASE_INSTRUCTIONS.md` and run from a clean `main` checkout whose `HEAD` matches `origin/main`.

## Architecture Invariants

Read this section before writing code. Each item below is a place where the
obvious change is silently incomplete.

### Adding an IPC channel is a 7-file dance
IPC handlers do **not** call `ipcMain.handle` directly. They register against
`commandRegistry` and the file binds its channel list to `ipcMain` at the
bottom (`main/src/ipc/git.ts` is the canonical example). A channel is not
reachable until every step below is done; missing step 4 fails silently at
runtime, missing step 7 fails loudly in CI.

1. `main/src/ipc/<domain>.ts` — add the string to that file's
   `DAEMON_*_CHANNELS` array **and** `commandRegistry.register(name, fn)`.
   The array is what `commandRegistry.bindChannels(ipcMain, ...)` consumes.
2. `main/src/ipc/index.ts` — only if you added a new `register*Handlers` file.
3. `shared/types/daemon.ts` — `DAEMON_OWNED_CHANNEL_PREFIXES` /
   `DAEMON_OWNED_EXACT_CHANNELS`. Skip only when an existing prefix
   (`sessions:`, `panels:`, `projects:`, `terminal:`, …) already covers it.
4. `main/src/preload.ts` — this file **duplicates** the daemon-owned lists
   inline, because a sandboxed preload cannot require local modules. If you
   touched step 3 you MUST mirror it here, or the channel bypasses the remote
   daemon bridge and only works locally.
5. `main/src/preload.ts` — add the method to the matching
   `contextBridge.exposeInMainWorld('electronAPI', …)` group.
6. `frontend/src/types/electron.d.ts` + `frontend/src/utils/api.ts` — typed
   signature and `API.*` wrapper.
7. `main/src/ipc/daemonRegistryBindings.test.ts` — the per-domain channel
   arrays are asserted with `toEqual`. Adding a channel without updating this
   file fails `pnpm --filter main test`.

Also update `tests/electronApiMock.ts` when a Playwright spec exercises the flow.

**Shortcut for panel-internal channels:** `window.electronAPI.invoke(channel, …)`
is a generic passthrough (see `TerminalPanel.tsx` calling `terminal:getState`).
It skips steps 5–6 — acceptable for internal plumbing, not for a public `API.*`
surface.

### `pnpm install` shadows the system `claude` binary
`main` depends on `@anthropic-ai/claude-code`, so `pnpm install` writes a
`claude` shim into `node_modules/.bin/`. Launching the app through a pnpm
script puts that directory at the front of `PATH`, and every agent terminal the
app spawns inherits it — so agents run the *bundled* Claude Code version rather
than the user's installed one. A version skew there surfaces as
`404 {"type":"not_found_error","message":"model: opus"}` or similar.

Nothing needs the shim: `claudeCodeManager` resolves the executable via
`findExecutableInPath('claude')` or the configured `claudeExecutablePath`, and
the package itself is only imported as a library. After a fresh install, delete
`node_modules/.bin/claude*` and `main/node_modules/.bin/claude*`.

### On Windows, dev builds write to the *production* data directory
`getAppDirectory()` auto-isolates to `~/.pane_dev` only when
`__CFBundleIdentifier === 'com.dcouple.pane'` — a **macOS-only** environment
variable. On Windows and Linux it falls through to `~/.pane`, so a dev run
shares the installed app's database and sockets. Always launch dev builds with
an explicit directory: `PANE_DIR=~/.pane_test pnpm dev`.

### Secondary terminal views must match the PTY's dimensions
Agent TUIs paint with absolute cursor positioning sized to the real PTY.
Replaying that byte stream into a terminal of a different width wraps every
line and each repaint pushes the viewport down — the console appears to scroll
without end. A read-only viewer must create its xterm at the PTY's exact
`cols`/`rows` (exposed on `TerminalPanelSnapshot`) and fit by choosing a font
size that makes those columns fit the available width. Scaling with a CSS
transform is the wrong lever: a 120-column terminal in a 400px tile lands at a
~4px glyph. Never use `FitAddon` for a secondary view.

### Every git/shell read goes through `CommandRunner`
`CommandRunner` transparently wraps commands for WSL and remote hosts. Never
call `execSync`/`child_process` directly from a service. Obtain a runner from
`sessionManager.getProjectContext(sessionId).commandRunner` or
`getProjectContextByProjectId(projectId).commandRunner`. Both can return `null`
for orphaned sessions or projects without sessions — return an error result,
do not throw.

### `main/src/database/migrations/*.sql` is dead code
Nothing executes those files; `copy:assets` ships them to `dist` and they are
ignored. Real schema lives in exactly two places:
- `main/src/database/schema.sql` — executed statement-by-statement (split on
  `;`) on every startup. Must be idempotent (`CREATE TABLE IF NOT EXISTS`), and
  must never contain a `;` inside a comment or string literal. Prefer `--`
  comments.
- `DatabaseService.runMigrations()` in `main/src/database/database.ts` —
  hand-written TypeScript using `PRAGMA table_info(...)` feature detection.
  Column additions, index creation and backfills go here.

For ad-hoc queries in a new service use `databaseService.getDb()` — the
sanctioned escape hatch (see `main/src/services/scrollbackRetention.ts`) —
rather than growing the ~5,000-line `database.ts` facade.

### Navigation has no router
`frontend/src/stores/navigationStore.ts` holds a single `activeView` enum. A
new full-page view means touching four places:
1. the exported `ActiveView` union in that file, plus a `navigateToX()` action,
2. the render switch in `frontend/src/components/SessionView.tsx`, near the
   `pane-chat` branch,
3. `frontend/src/components/Sidebar.tsx` — the **compact rail**,
4. `frontend/src/components/ProjectSessionList.tsx` — the **expanded tree**.

Sidebar entries live in two separate files; updating only one is the classic
miss. `PaneChatView.tsx` is the reference implementation of a full-page view.

### Adding a `ToolPanelType` is ~14 touchpoints
`PanelContainer` (lazy import + switch), `PanelTabBar` (`getPanelIcon`,
`typeOrder`, the create menu), `PanelTabStrip` (a **second, duplicated**
`getPanelIcon`), `PanelLoadingFallback`, the `PanelGroupView` keep-alive list,
`PANEL_CAPABILITIES` in `shared/types/panels.ts`, the `checkInitialized` switch
in `main/src/ipc/panels.ts`, and a `panelManager.ensureXxxPanel` helper. Panels
are keyed by `sessionId`; prefer a new `activeView` for anything that is not
scoped to a single session.

### Agents are terminal panels, not a panel type
An "agent" is a `terminal` panel whose `customState.isCliPanel === true`, with
`agentType: 'claude' | 'codex'`. `frontend/src/components/panels/cli/` is dead
code. "Is it running?" is answered by the agent-status pipeline, **not**
`Session.status`: `terminalPanelManager.pollAgentStatus` → `detectAgentState` →
`panel:agentStatus` event → `App.tsx` listener → `usePanelStore.setAgentStatus`.
Roll several panels up with `frontend/src/utils/agentStatus.ts`; read via
`frontend/src/hooks/useAgentStatus.ts`. States: `blocked | working | idle | unknown`.

### Terminals: WebGL and the shared texture atlas
xterm instances that share font and theme **share a WebGL texture atlas**;
clearing it from one corrupts the others (see the header comment in
`frontend/src/components/panels/TerminalPanel.tsx`). Never call
`clearTextureAtlas()`. Secondary or read-only terminal views must not load
`WebglAddon` at all — Chromium also caps live WebGL contexts at ~16.
`terminalPanelManager.setVisibility(panelId, visible, viewerId)` is refcounted
per viewer: always pass a distinct, prefixed `viewerId`, and always release it
on unmount.

### Lint rules that will fail your PR
- `@typescript-eslint/no-explicit-any` is an **error** in both packages. Parse
  untrusted JSON as `unknown` and narrow with hand-written type guards.
- The frontend enforces ~13 `jsx-a11y` rules as errors, notably
  `click-events-have-key-events` and `no-static-element-interactions`. Never put
  `onClick` on a `<div>` or an SVG element — wrap the row in
  `<button type="button">` and mark decorative SVG `aria-hidden="true"`.
- `no-console` is a warning in the frontend (`warn`/`error` allowed); console is
  allowed in `main/`.

## Coding Style & Naming Conventions
- Use TypeScript throughout; follow ESLint configs in `frontend/eslint.config.js` and `main/eslint.config.js`.
- Indentation 2 spaces; prefer explicit types at module boundaries.
- Naming: `camelCase` for variables/functions, `PascalCase` for React components/types, `kebab-case` for filenames (React files may match component name).
- Do not introduce explicit `any`; use a specific type or `unknown` with narrowing. ESLint enforces `@typescript-eslint/no-explicit-any` at error level.
- Run `pnpm lint && pnpm typecheck` before sending PRs.

## Testing Guidelines
- E2E tests live in `tests/*.spec.ts` (Playwright). Example: `pnpm test -- tests/smoke.spec.ts`.
- Add Playwright tests for user-visible flows; mock external services where possible.
- For backend logic in `main/`, use Vitest colocated under `main/src/**/__tests__` or `*.spec.ts`.

## Commit & Pull Request Guidelines
- Commits: present tense, focused, reference issues (e.g., "Fix session diff flicker, closes #123").
- PRs must include: clear description, linked issues, testing notes; screenshots/GIFs for UI changes.
- If dependencies change, run `pnpm run generate-notices` and commit updated `NOTICES`.

## Security & Configuration Tips
- The root development toolchain requires Node >= `22.18`; `pnpm` >= `8`. Use `pnpm` only. Electron 41 bundles Node 24 for the app, while the published `packages/runpane` wrapper intentionally supports Node >= `18.17`.
- Secrets via `.env` (dotenv) for local dev; never commit secrets.
- To avoid clobbering local data when hacking on Pane with Pane: `PANE_DIR=~/.pane_test pnpm dev`.

## Agent Notes (for automation)
- Keep changes minimal and scoped; prefer small patches.
- Treat blocking lint as the new-code floor. Every Knip category is blocking; advisory anti-slop output records existing debt. Address relevant findings without broad suppressions. See `references/anti-slop.md` and `references/oxlint-overlap.md`.
- `pnpm perf:scan` enables React Scan only for that Vite dev session and emits `[render-evidence]` summaries for pane switching and Remote PWA churn. Production builds must never include React Scan. Component counts do not measure xterm/WebGL, Electron main-process, IPC, or network cost.
- For WSL git-status work, keep filesystem watching inside the distro: prefer `inotifywait`; without it Pane intentionally falls back to a five-second WSL-native `git status` poll while focused. Do not add Windows-side recursive watchers over `\\wsl.localhost` or `\\wsl$`.
- Development runs capture renderer and main-process output in root `frontend-debug.log` and `backend-debug.log`; inspect those logs when reproducing app failures. They are reset when development starts.
- Before proposing a new dependency, check whether the repo already solves it. There is no chart library and no router by deliberate choice; charts are hand-rolled SVG under `frontend/src/components/ui/charts/` and navigation is a single `activeView` enum.
- Update docs alongside code; do not alter build targets without discussion.
- Use repository scripts (pnpm) and keep formatting consistent with existing files.
- For RunPane local-control debugging on macOS, test against an isolated Pane directory (for example `PANE_DIR=~/.pane_test pnpm dev`) and validate with the local wrapper (`node packages/runpane/dist/cli.js doctor --json --pane-dir ~/.pane_test`, then `repos list`, `repos add --path ... --yes`, and `panes list`). Use Node 22 for repo scripts; if switching between Vitest/plain Node and Electron dev runs, rebuild native modules for the target runtime (`npm rebuild better-sqlite3-multiple-ciphers` for Node, `pnpm electron:rebuild` for Electron).

<!-- pane-agent-context:start -->
## Pane

The developer is using Pane for this repository. Pane can manage saved repositories and create user-visible panes with terminal-backed tools for planning, discussion, implementation, and review work.

Start with `runpane doctor --json` before taking Pane actions. Use it to understand wrapper/runtime details, daemon reachability, and the next safe commands.

In a Pane repository checkout, if `runpane` is not on PATH, use the built local wrapper with Node 22: `PATH=/opt/homebrew/opt/node@22/bin:$PATH node packages/runpane/dist/cli.js doctor --json`.

Use `runpane agent-context --json` for full Pane CLI context. Use `runpane agent-context --command "panels wait" --json` or another command name for detailed schema only when needed.

Default to context-safe validation: after creating panes or sending terminal input, run `runpane panels wait` or `runpane panels screen` before reporting success. Prefer `runpane panels submit` for normal text plus Enter; use `runpane panels input` only for exact bytes such as Ctrl-C or escape sequences.

Common commands:
- `runpane doctor --json`
- `runpane agent-context --json`
- `runpane repos list --json`
- `runpane repos add --path <repo> --yes --json`
- `runpane agents doctor --agent codex --repo active --json`
- `runpane panes create --repo active --name <name> --agent codex --prompt "<task>" --wait-ready --yes --json`
- `runpane panels list --pane <pane-id> --json`
- `runpane panels screen --panel <panel-id> --limit 80 --json`
- `runpane panels wait --panel <panel-id> --for ready --timeout-ms 30000 --json`
- `runpane panels submit --panel <panel-id> --text "<answer>" --yes --json`
- `runpane panels input --panel <panel-id> --input-file <path|-> --yes --json`

WSL note: if `runpane doctor --json` cannot find `/tmp/pane-daemon.../daemon.sock` or `runpane` resolves to a broken Windows shim, Pane may be running on Windows. Try `powershell.exe -NoProfile -Command 'Set-Location $env:TEMP; runpane doctor --json'`, then create panes through the same PowerShell form using the saved WSL repo name or id. Use `runpane agents doctor --agent codex --repo <selector> --json` to diagnose the repo environment Pane will actually use.
<!-- pane-agent-context:end -->
