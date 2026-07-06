# Repository Guidelines

## Project Structure & Module Organization
- Root `pnpm` workspace with packages: `main/` (Electron main process, TypeScript), `frontend/` (React + Vite), `shared/` (shared types), and `tests/` (Playwright E2E).
- Key paths: `main/src/{services,ipc,utils}/`, `frontend/src/{components,hooks,stores,utils}/`, `main/assets/`, `scripts/`.
- Build artifacts: `frontend/dist/`, `main/dist/`, packaged output `dist-electron/`.

## Build, Test, and Development Commands
- Dev app: `pnpm dev` (spawns frontend + Electron).
- Build all: `pnpm build` (frontend, main, then electron package).
- Package (examples): `pnpm build:mac`, `pnpm build:linux`.
- Lint: `pnpm lint`; Type-check: `pnpm typecheck` (runs per package).
- Tests (E2E): `pnpm test`, `pnpm test:ui`, CI configs in `playwright.ci*.config.ts`.
- Main unit tests (if added): `pnpm --filter main test`, coverage: `pnpm --filter main run test:coverage`.

## Coding Style & Naming Conventions
- Use TypeScript throughout; follow ESLint configs in `frontend/eslint.config.js` and `main/eslint.config.js`.
- Indentation 2 spaces; prefer explicit types at module boundaries.
- Naming: `camelCase` for variables/functions, `PascalCase` for React components/types, `kebab-case` for filenames (React files may match component name).
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
- Node >= `22.14`; `pnpm` >= `8`. Use `pnpm` only.
- Secrets via `.env` (dotenv) for local dev; never commit secrets.
- To avoid clobbering local data when hacking on Pane with Pane: `PANE_DIR=~/.pane_test pnpm dev`.

## Agent Notes (for automation)
- Keep changes minimal and scoped; prefer small patches.
- Update docs alongside code; do not alter build targets without discussion.
- Use repository scripts (pnpm) and keep formatting consistent with existing files.
- Always review the root `CLAUDE.md` before beginning any work. 
- Scan the repository for every `CLAUDE.md`, and when working in a folder or any of its subfolders that has one, read and follow that file too.
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
