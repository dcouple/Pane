# Implementation brief: workspace entry and sidebar state

Status: **READY for Heavy `/do`**; owner decisions are recorded below.  
Baseline inspected: `origin/main` at `169f8aa3` (`v2.4.87`), which matches this worktree's `HEAD` as of 2026-08-29.

## Outcome

Make the sidebar behave like a workspace navigator rather than a Git control:

- Right-clicking a worktree Pane can rename Pane's display label without renaming its Git branch, worktree directory, or path.
- Completing the interactive desktop Add Repository flow automatically creates exactly one terminal for the configured default agent in that newly added project, when one is configured. If no default is configured or launch fails, the project opens in its blank state without a placeholder or failed tab.
- Sidebar selection and hover use neutral surface backgrounds. Agent state remains visible through the existing dot/badge vocabulary, not a colored left rail.

## Owner decisions

- Keep the workstream bounded to the interactive desktop Add Repository flow. Use the existing app-wide `defaultOrchestratorAgent` once for each newly added project; exclude legacy backfill, onboarding, and RunPane registration.
- Submitting Add Repository authorizes launching the configured agent with its existing permissive preset and no initial prompt. The dialog must clearly disclose that launch, including the selected agent, and must not add a second confirmation.
- If no default agent is configured, create and open the project in its blank state and wait for the user to open a first Pane. This defensive path does not require adding a new “None” setting.
- If automatic launch fails, preserve and open the project in its blank state; remove any provisional/failed agent tab. Show only a non-modal, non-blocking error that says the project was added but the agent could not start, with one manual **Open agent** action when the existing panel-creation path can provide it. Do not automatically retry.
- Write the one-shot success receipt only after the agent panel is successfully created. Any automatic-launch failure that removes the panel must leave no success receipt; later automatic navigation still must not become an implicit retry trigger.
- Explicit manual Pane names outrank PR-title auto-naming, duplicate display names are allowed, and neutral sidebar highlight/status decisions remain as specified below.

## Problem and root-cause check

The three visible requests do not have the same underlying cause.

- **Rename is an affordance/precedence problem, not a Git-model problem.** Pane already stores a session `name` separately from `worktree_name` and `worktree_path`; the missing piece is an expanded-sidebar action and a single rule that the Pane name is the visible label.
- **First-entry agent launch is a lifecycle ownership problem.** Repository creation, navigation, lazy main-session creation, panel creation, and terminal process launch currently cross renderer/main boundaries. Adding another renderer effect would treat the symptom and remain vulnerable to remounts, retries, and concurrent calls.
- **Accent bars are redundant presentation.** Mainline already has neutral selected/hover tokens and an accessible agent-status badge. The expanded row alone still uses a second, full-height semantic-color channel.

## Current-state evidence

### Pane names and Git identities are already separate

- The session schema has independent `name`, `worktree_name`, and `worktree_path` columns (`main/src/database/schema.sql:13-20`); the database model preserves the same distinction (`main/src/database/models.ts:54-60`). No Git rename or schema split is needed.
- `sessions:rename` already updates only `{ name }` and emits `session-updated` (`main/src/ipc/session.ts:1422-1437`). The preload bridge and renderer API already expose it (`main/src/preload.ts:570-575`, `frontend/src/utils/api.ts:329-337`). RunPane's existing pane-rename path follows the same display-only persistence pattern (`main/src/ipc/runpane.ts:394-414`).
- The window title already reads `session.name` and uses the worktree folder only as a fallback (`frontend/src/utils/paneTitle.ts:15-30`), while session updates flow into the Zustand store (`frontend/src/hooks/useIPCEvents.ts:177-196`). A successful rename can therefore update the title and every duplicate rendering without a new event type.
- The compact rail already handles `contextmenu`, but its menu contains only Pin/Unpin and Archive (`frontend/src/components/Sidebar.tsx:479-505`, `frontend/src/components/Sidebar.tsx:558-584`, `frontend/src/components/CompactSessionMenu.tsx:18-45`). Expanded `SessionRow` has archive/pin hover buttons and no context-menu hook (`frontend/src/components/ProjectSessionList.tsx:653-661`, `frontend/src/components/ProjectSessionList.tsx:740-801`).
- Expanded rows currently prefer `gitStatus.prTitle` over `session.name` (`frontend/src/components/ProjectSessionList.tsx:584`, `frontend/src/components/ProjectSessionList.tsx:738`). That would make a manual rename appear not to work for a Pane with a PR. The settings UI also advertises automatic PR-title naming (`frontend/src/components/settings/categories/WorktreesGitSettings.tsx:73-82`), so manual-name precedence must be deliberate and tested.

### New project entry currently creates no working tool

- `AddProjectDialog` creates the project, emits `project-changed`, and navigates to it (`frontend/src/components/AddProjectDialog.tsx:36-63`). `projects:create` persists/configures the repository but creates no session or panel (`main/src/ipc/project.ts:115-231`).
- On project-view mount, `ProjectView` calls `getOrCreateMainRepoSession`; the renderer then loads whatever panels exist and explicitly performs no auto-creation (`frontend/src/components/ProjectView.tsx:95-114`, `frontend/src/components/ProjectView.tsx:272-310`).
- Main-process creation is already serialized by a per-project lock. A new main session gets only permanent Explorer and Diff inspector panels, with Explorer selected (`main/src/services/sessionManager.ts:531-586`). The IPC handler infers “new” from pending status, emits creation, then marks it stopped (`main/src/ipc/session.ts:742-761`).
- The only current configurable agent default is `defaultOrchestratorAgent`; its type comment and settings label scope it to global Pane Chat (`frontend/src/types/config.ts:72-73`, `frontend/src/components/settings/categories/AIAgentsSettings.tsx:40-58`). It defaults to Claude and is normalized on config load (`main/src/services/configManager.ts:56-59`, `main/src/services/configManager.ts:169-175`).
- Shared launch presets already define supported agent IDs, titles, commands, and platform constraints (`shared/constants/agentLaunchPresets.ts:1-55`). The tab `+` menu already uses those presets (`frontend/src/components/panels/PanelTabBar.tsx:138-142`, `frontend/src/components/panels/PanelTabBar.tsx:661-675`).

### Neutral interaction state and status badges already exist

- `surface-hover` and theme-derived `surface-selected` tokens exist (`frontend/src/styles/tokens/colors.css:483-488`). Expanded rows already use selected vs hover backgrounds (`frontend/src/components/ProjectSessionList.tsx:740-746`); compact controls share `COMPACT_RAIL_ACTIVE`/`IDLE` using the same tokens (`frontend/src/components/Sidebar.tsx:83-85`).
- Expanded rows additionally render `StatusAccentBar`, a full-height red/blue/green bar with working animation (`frontend/src/components/ProjectSessionList.tsx:748-749`, `frontend/src/components/ui/StatusAccentBar.tsx:10-36`).
- The reusable `SessionStatusBadge` already rolls terminal-agent state up to blocked/working/done/idle and renders the established dot/spinner (`frontend/src/components/SessionStatusBadge.tsx:12-32`). Compact Pane entries use it today (`frontend/src/components/Sidebar.tsx:495-504`, `frontend/src/components/Sidebar.tsx:574-583`); project headers use the same status-dot family (`frontend/src/components/ProjectSessionList.tsx:402-410`, `frontend/src/components/ProjectSessionList.tsx:463-469`).
- Playwright already asserts neutral selected backgrounds in full and compact modes and exercises compact right-click actions (`tests/sidebar-compact.spec.ts:87-126`, `tests/sidebar-compact.spec.ts:128-180`).

## Proposed implementation contract

### 1. Display-only rename

- Extend one shared Pane context menu to both expanded and compact worktree entries, including their pinned copies. Order: **Rename**, Pin/Unpin, divider, Archive.
- Rename opens a focused text input initialized to the current Pane name. Enter saves; Escape/outside cancel; whitespace-only input is rejected; leading/trailing whitespace is trimmed. Do not invent a new length limit when the persistence layer has none.
- Persist through the existing `sessions:rename` contract. Harden that handler so all UI/CLI call sites share non-empty trimmed-name validation. The update must touch `sessions.name` only and emit the existing session update.
- A manually chosen Pane name is authoritative everywhere: expanded row, compact tooltip/accessible label, pinned copy, title bar, notifications, and RunPane list output. PR title remains PR metadata (tooltip/pill), never a silent renderer-only substitute for the explicit label.
- Automatic PR-title naming must not overwrite a later manual rename. If the current `pr_renamed` flag cannot express that provenance, add the smallest explicit per-session provenance needed; do not infer intent from string equality.
- Duplicate display names are allowed. Session ID remains the identity; the branch/worktree name stays visible in detail tooltips for disambiguation.

### 2. Launch the configured default agent once

- Reuse `defaultOrchestratorAgent` as the application-wide default for both Pane Chat and first entry into a newly added repository; update settings copy so its scope is truthful. Do not add a second competing default in this workstream.
- Trigger only for a project newly created by the interactive Add Repository flow. Existing projects are not backfilled, and `runpane repos add` remains registration-only. Onboarding behavior remains unchanged unless explicitly brought into scope.
- In the Add Repository dialog, disclose that submission will start the named default agent with its configured permissive preset. The Add action is the authorization boundary; do not add another confirmation.
- If no default agent is configured, finish project creation and navigation with no terminal panel. The ordinary blank-state action remains the way to open a first Pane.
- Put the idempotency decision in main-process workspace initialization, adjacent to the existing per-project main-session lock—not in `ProjectView` effects. Persist a receipt/state that distinguishes “the automatic panel was created” from “there happens to be no agent panel now.”
- During the create flow, serialize creation of the new main-repository session (if needed), Explorer/Diff inspectors, and exactly one terminal panel using the selected shared preset. Write the success receipt only after that panel is successfully created; validation, persistence, or launch failure must not write or retain it.
- Persist enough terminal state (`initialCommand`, `agentType`, CLI marker/title) for existing launch, resume, and status systems. Navigation then loads that durable panel and the existing terminal lifecycle starts the process.
- “Exactly once” means one automatic panel/process initiation per newly added project. Reopening, renderer remount, duplicate/concurrent initialization calls, app restart, changing the default, or manually closing the tab must not create another. Existing terminal restore/resume behavior is not reclassified as a second automatic launch.
- Sample the configured default at initialization time. Later default changes are non-retroactive.
- Validate platform support before panel persistence where possible. If automatic launch fails at any stage, keep the project, remove any provisional/failed agent tab, select the normal blank project state, and show a non-modal error with a single manual **Open agent** action when available through the existing panel-creation path. Do not silently fall back, automatically retry, or create a replacement panel.

### 3. Neutral sidebar states

- Remove the colored `StatusAccentBar` from expanded Pane rows and delete the component if no uses remain. Restore the reclaimed left padding to normal row alignment.
- Keep `bg-surface-selected` for selected rows and `hover:bg-surface-hover` for unselected hover in both expanded and compact sidebars. Focus remains a separate visible focus ring.
- Add the existing `SessionStatusBadge` to expanded Pane rows in a stable trailing position. Keep compact Pane badges and project-level rollups unchanged. Semantic color is allowed inside those compact icons/badges and PR/diff metadata, not as a row-edge selection/accent rail.
- Working animation stays in the status badge/spinner only; selection and hover remain static surfaces.

## Scope and likely touch points

- Sidebar context-menu state and rendering: `frontend/src/components/Sidebar.tsx`, `frontend/src/components/ProjectSessionList.tsx`, and a generalized replacement for `frontend/src/components/CompactSessionMenu.tsx`.
- Rename input/dialog and validation: existing UI primitives plus `frontend/src/utils/api.ts` and `main/src/ipc/session.ts`; session-name provenance only if needed for manual-over-auto precedence.
- First-entry initialization: `main/src/ipc/project.ts`, `main/src/services/sessionManager.ts` or a narrowly owned workspace-initialization helper, panel creation, config naming, and shared agent presets. `ProjectView` should consume the initialized state, not own the once-only side effect.
- Sidebar presentation: `ProjectSessionList.tsx`, `SessionStatusBadge.tsx` reuse, removal of `StatusAccentBar.tsx`, and focused tests/screenshots.
- Documentation: update the AI & Agents setting description and any user docs that call the default Pane Chat-only.

## Non-goals

- Renaming Git branches, `worktree_name`, worktree directories/paths, remote refs, PRs, or filesystem folders.
- A general Git worktree-management rename command.
- Project-specific default-agent settings, initial prompts, agent auto-fallback, or automatic retries.
- Auto-launch/backfill for repositories registered before this change, `runpane repos add`, or onboarding.
- A new “no default agent” setting, transactional rollback of a successfully added project, or placeholder/failed tabs after automatic-launch errors.
- Redesigning Pane Chat, terminal restore/resume, agent status semantics, PR metadata, project names, archived-Pane actions, or the remote PWA sidebar.
- Re-theming semantic status colors outside the sidebar accent-bar removal.

## Acceptance criteria

1. Right-clicking any active worktree Pane row in expanded or compact sidebar mode exposes Rename; the same is true for its pinned rendering.
2. Saving `  Human label  ` displays and persists `Human label`; blank input cannot be saved; cancel makes no change; focus returns predictably.
3. Rename changes only `sessions.name`. Before/after Git branch, `worktree_name`, `worktree_path`, filesystem location, and PR association are identical.
4. A rename propagates without reload to the expanded row, compact tooltip/label, pinned copy, active window title, and other current consumers of `session.name`.
5. A Pane with a PR still shows the explicit renamed label; PR title/number remain available as metadata. Later Git-status refresh cannot undo the manual label.
6. When `defaultOrchestratorAgent` is configured, completing the interactive desktop Add Repository flow discloses and then creates/opens one main-repository terminal for that agent, alongside the existing Explorer/Diff inspectors; the Add action is the only confirmation.
7. Two concurrent initialization requests, React Strict Mode/remount, navigation away/back, and app restart produce no additional automatic agent panel. Closing the initial agent tab also does not recreate it.
8. Changing the default after project initialization has no effect on that project. A later newly added project uses the new default.
9. With no configured default agent, Add Repository still creates and opens the project with zero terminal panels; it stays blank until the user manually opens a first Pane.
10. If automatic validation, persistence, executable startup, or authentication fails, the project remains added and opens blank with no provisional, failed, fallback, or replacement tab. No success receipt is written, no later navigation automatically retries, and a non-modal error offers one manual **Open agent** action when the existing creation path supports it.
11. The new-project action itself does not seed repository-controlled input. Legacy projects, onboarding, and RunPane registration never invoke this automatic-launch path.
12. No full-height colored status/accent bar remains on Pane rows. Selected, hover, and focus states are visually distinct through neutral surfaces/ring across supported themes.
13. Expanded and compact rows still expose blocked, working, done, idle, and unknown agent states through existing accessible icons/badges; working motion exists only in the badge.
14. `pnpm lint`, `pnpm typecheck`, relevant main/frontend unit tests, and focused Playwright specs pass.

## Test and QA plan

### Automated

- Main-process rename tests: trim/reject blank; update only `name`; emit once; preserve worktree/branch fields; not-found/error behavior; manual-name precedence over PR refresh.
- Main-session/initialization tests: each default agent; no configured default; newly added vs legacy/onboarding/RunPane project; supported/unsupported environment; sequential and concurrent duplicate calls; restart/reload from persisted receipt; closed-panel non-recreation; validation/persistence/launch failure cleans up the panel, preserves the project, and writes no receipt.
- Renderer tests: expanded and compact context menus; keyboard save/cancel/error; pinned mirror; live title update; PR-bearing Pane retains manual label; Add Repository disclosure; no-second-confirmation launch; blank success path; non-modal failure with its manual action.
- Sidebar status tests: no accent-bar element/role; `SessionStatusBadge` present in expanded and compact modes; selected/hover/focus classes and accessible status labels remain correct.
- Extend `tests/sidebar-compact.spec.ts` or add a focused `tests/sidebar-pane-actions.spec.ts`; add main Vitest coverage beside session/project initialization. Update `tests/electronApiMock.ts` only with contract-faithful state/call recording.
- Run `pnpm theme:contrast`; capture focused dark, light, high-contrast, and colorblind-safe sidebar screenshots. Use the existing batch theme harness if shared tokens/components change.

### Manual QA

- macOS plus Windows native and WSL-backed repositories: add a repository, verify the named-agent disclosure, watch the correct agent start once, navigate/restart/close/reopen, and verify no duplicate.
- Exercise no-default and forced launch-failure paths: the project remains registered and opens blank, no failed tab survives, no automatic retry occurs, and the manual error action is usable without a modal interruption.
- Rename a stopped, working, blocked, pinned, PR-bearing, and long-name Pane in both sidebar widths. Confirm `git branch --show-current`, worktree path, and PR remain unchanged.
- Inspect hover/selected/focus/status combinations at normal and narrow sidebar widths; verify status is readable without relying on the removed bar and context-menu focus is keyboard-safe.

## Risks and dependencies

- **Automatic execution/trust:** the shared presets launch agents with permissive flags (`--dangerously-skip-permissions`, `--yolo`, or `--force --trust`). The approved authorization boundary is the disclosed interactive Add Repository submission, with no repository-provided prompt and no second confirmation.
- **Duplicate launch race:** panel-count checks and React refs are insufficient. Panel creation and success-receipt persistence must be serialized in main-process initialization, with receipt ordering that cannot mark a cleaned-up failure as successful.
- **Partial-failure cleanup:** process startup crosses durable panel creation and runtime launch. The implementation must define one cleanup path that removes a failed automatic panel without rolling back the project or disturbing Explorer/Diff, and must make the non-modal error actionable without introducing auto-retry.
- **Name provenance:** current PR-title rendering can mask manual names, while the advertised auto-rename preference lacks an obvious current producer. Manual-wins behavior may require a small migration or a deliberate cleanup of stale PR-rename behavior.
- **Default semantics:** broadening `defaultOrchestratorAgent` requires settings/docs copy changes and platform validation against the project environment.
- **Multiple add paths:** UI project creation, onboarding, and RunPane registration call project persistence separately. This brief intentionally includes only the interactive Add Repository path; broadening it requires a shared initialization contract and trust decision.
- **Remote runtime:** remote PWA sidebar and host-side project registration are excluded. Do not accidentally create a client-side duplicate when the host is authoritative.

## Comparable product prior art

- VS Code workspace folders can have a user-facing `name` independent of their resource `path`, supporting Pane's display-label/Git-identity split: [Multi-root Workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces#_workspace-file-schema).
- VS Code defines independent list/tree selection and hover backgrounds while badges carry compact information, matching the proposed separation of interaction state from agent status: [Theme Color Reference](https://code.visualstudio.com/api/references/theme-color#lists-and-trees).
- VS Code's first-open task automation has an explicit configuration/trust gate and instance limits. It is not the same feature, but it reinforces the need for a clear source and idempotency boundary: [Tasks: run behavior](https://code.visualstudio.com/docs/debugtest/tasks#_run-behavior).
