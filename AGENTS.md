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
- Lint: `pnpm lint`; Type-check: `pnpm typecheck` (runs per package). The root lint command is the single entry point for blocking Oxlint, residual ESLint, advisory anti-slop, and advisory Knip checks.
- Detailed advisory output: `pnpm lint:ox:extra:details`; accessibility scan: `pnpm a11y:scan` (install Chromium once with `pnpm exec playwright install chromium`); opt-in render evidence: `pnpm perf:scan`.
- Tests (E2E): `pnpm test`, `pnpm test:ui`, CI configs in `playwright.ci*.config.ts`.
- Main unit tests (if added): `pnpm --filter main test`, coverage: `pnpm --filter main run test:coverage`.
- Releases must follow `docs/RELEASE_INSTRUCTIONS.md` and run from a clean `main` checkout whose `HEAD` matches `origin/main`.

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
- Treat blocking lint as the new-code floor. Advisory anti-slop and Knip output records existing debt; address relevant findings without broad suppressions. See `references/anti-slop.md` and `references/oxlint-overlap.md`.
- `pnpm perf:scan` enables React Scan only for that Vite dev session and emits `[render-evidence]` summaries for pane switching and Remote PWA churn. Production builds must never include React Scan. Component counts do not measure xterm/WebGL, Electron main-process, IPC, or network cost.
- For WSL git-status work, keep filesystem watching inside the distro: prefer `inotifywait`; without it Pane intentionally falls back to a five-second WSL-native `git status` poll while focused. Do not add Windows-side recursive watchers over `\\wsl.localhost` or `\\wsl$`.
- Development runs capture renderer and main-process output in root `frontend-debug.log` and `backend-debug.log`; inspect those logs when reproducing app failures. They are reset when development starts.
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
