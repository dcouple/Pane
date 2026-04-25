# Brief: background battery cost on Pane (ARM Windows / WSL)

## Context

User runs roughly 5 Claude panels in the background while working in a foreground panel. Target platform where the pain is most visible: ARM Windows (Snapdragon). Goal is to reduce excess work done by hidden panels. Goal is not to match native Windows Terminal power draw (unreachable for any Electron app), but to close the gap on clear waste.

### Key structural fact

Claude and Codex panels are `panel.type === 'terminal'` with `isCliPanel: true`. They render through `frontend/src/components/panels/TerminalPanel.tsx`, which means every Claude/Codex panel is a full xterm + WebGL instance. Inactive panels stay mounted with `display: none` (`frontend/src/components/SessionView.tsx:976-985`, gated by `shouldKeepAlive = ['terminal', 'browser'].includes(panel.type)`). They do not unmount when the user switches tabs.

The deprecated `frontend/src/components/panels/cli/` folder (`BaseCliPanel.tsx`, `CliPanelFactory.tsx`) is not in the render path. Ignore it.

## Verified good posture (keep as-is)

- WebGL renderer enabled with `onContextLoss` handler (`TerminalPanel.tsx:422-439`).
- No ligatures addon. No CanvasAddon alongside WebGL.
- Scrollback is 2,500 (`TerminalPanel.tsx:284`). CLAUDE.md's "50,000 line scrollback" claim is stale for the xterm ring.
- `cursorBlink: false`, `minimumContrastRatio: 1` (disabled), so no per-tick redraws from those.
- PTY output coalescing in main (`main/src/services/terminalPanelManager.ts:13-16`): 32 ms batch window, 128 KB size cap, 100 KB high watermark, PTY pause + renderer ACK flow control.
- node-pty ARM64 Windows prebuild via `@lydell/node-pty-win32-arm64@1.2.0-beta.3` (`pnpm-lock.yaml:1219`). No source rebuild on install.
- `isActive`-gated resize (`TerminalPanel.tsx:992`).

## Fix candidates (verified waste on hidden panels)

### 1. Detach WebGL addon when panel becomes inactive
Reattach on activate. Hidden xterm falls back to DOM renderer; DOM paint is skipped entirely for `display: none` subtrees, so the work goes near-zero. WebGL addon has `.dispose()` and can be re-loaded via `loadAddon()`.

Dependency: open verification item below (is the WebGL renderer actually issuing GL draws while hidden, or does it already self-gate).

### 2. Raise PTY batch cadence for hidden panels
Current `OUTPUT_BATCH_INTERVAL = 32` ms fires for every panel regardless of visibility. Add a hidden-panel cadence (proposed 250 ms) and a renderer-to-main visibility signal so `terminalPanelManager.ts` knows which panels are hidden. Reduces IPC wake-ups on hidden panels roughly 8x. ACK chatter drops proportionally, so no separate fix needed.

### 3. Stop the 30 s SerializeAddon interval on hidden panels

**What the SerializeAddon is.** xterm's `@xterm/addon-serialize` walks the terminal's in-memory buffer (visible rows + scrollback) and emits a string containing text plus ANSI escape sequences. Replaying that string into a fresh xterm reproduces the current visual state: colors, cursor position, text styles. It is distinct from raw PTY scrollback, which preserves the output bytes but not the rendered visual state.

**What Pane does with it.** Pane uses snapshots to restore formatted contents after a PTY has died within the running app, or across a panel unmount/remount in the same session. Call sites in `TerminalPanel.tsx`:

- Every 30 s via `setInterval` while the panel is alive (`TerminalPanel.tsx:549-559`). Ships the serialized string to main via `terminal:saveSnapshot`.
- Once on unmount / dispose (`TerminalPanel.tsx:1050-1057`).

**Storage.** Snapshots are stored in-memory only in `terminalPanelManager.ts:905-946` (`this.serializedBuffers: Map<panelId, string>`), with an 8 MB per-snapshot cap and 64 MB global cap that prunes oldest on overflow. They do not get persisted to `sessions.db`. They do not survive app restarts.

**What each invocation costs.**
- Renderer walks the full 2,500-line buffer and builds the serialized string. CPU + allocation, O(buffer size).
- IPC roundtrip renderer to main with the full string as payload.
- Main-process updates the in-memory Map; potential prune pass.

**Why it matters for 5 background panels.** The interval fires regardless of `isActive`. Even without disk writes, every 30 s each of 5 hidden panels does a full buffer walk + string build + IPC payload. Steady CPU and GC pressure for no user-visible benefit while the panel is hidden.

**Fix.** The dispose-time call at `TerminalPanel.tsx:1050-1057` already handles clean unmount. The 30 s interval protects against hard tab-switch / panel remount within an active app (losing formatted restore). Replace the interval with:
- Snapshot once on active-to-inactive transition (covers tab switches and panel hides).
- Leave the dispose-time snapshot as the backstop.

Worst-case loss on hard crash is the last pre-deactivation visual state, which is acceptable since Pane does not persist snapshots across restarts anyway.

### 4. Scrollback retention policy for archived sessions

**What the DB growth actually is.** `sessions.db` is 238.7 MB on the profiled machine. Breakdown:

- `tool_panels.state` column: 218.6 MB (~95% of the file). 1,731 rows, avg 123 KB each, max 1 MB.
- Every other table combined: ~0.3 MB. `conversation_messages`, `execution_diffs`, `prompt_markers` are empty.

`tool_panels.state` is a JSON blob per panel that includes `$.customState.scrollbackBuffer`, the raw PTY scrollback (with ANSI escape codes). Written by `saveTerminalState` (distinct from the SerializeAddon path above). No retention policy exists today; archived sessions keep their `state` verbatim forever.

**By archived status on the profiled machine:**
- Active sessions: 62 sessions, 304 panels, 27.9 MB of state.
- Archived sessions: 297 sessions, 1,427 panels, 180.6 MB of state.
- No orphans.

**Retention policy (new feature).**

Rule: on every boot, in the main process, delete the `scrollbackBuffer` field from `tool_panels.state` for any panel whose session is archived and has not been viewed recently.

```sql
UPDATE tool_panels
SET state = json_remove(state, '$.customState.scrollbackBuffer')
WHERE session_id IN (
  SELECT id FROM sessions
  WHERE archived = 1
    AND (last_viewed_at IS NULL OR last_viewed_at < datetime('now', '-21 days'))
);
```

Design choices:
- **Timestamp:** `sessions.last_viewed_at`. No `archived_at` column exists; adding one would need a migration and does not change user-facing semantics meaningfully. `last_viewed_at` captures "haven't touched this archive in X days" which is what the retention is really about.
- **NULL handling:** treat `last_viewed_at IS NULL` as "very old" and include in the sweep. On the profiled data, this catches 16 archived sessions with no recorded view.
- **Retention window:** 21 days, hardcoded constant for now. Surface in Settings later if needed.
- **Timing:** run on boot, deferred ~3 s after the main window is `ready-to-show`. Not on shutdown (shutdown can be skipped by crashes / force-quits / OS power-off; boot is deterministic).
- **Scope of deletion:** only `$.customState.scrollbackBuffer`. Keep the rest of `state` (cwd, dimensions, shellType, cliReady flags, etc.) so unarchiving still restores a usable panel shell, minus historical output.
- **Also clear `$.customState.serializedBuffer`** if present, for the same reasons. Verify key exists in the JSON samples before finalizing the `json_remove` path list.
- **VACUUM:** do not run on boot. SQLite reuses freed pages on subsequent writes, so the file will stop growing even if it does not immediately shrink. A one-shot VACUUM can be exposed as a Settings action later.
- **Telemetry:** log `[ScrollbackRetention] Cleared N panels across M sessions, freed ~X MB` to the main log. No UI toast.
- **Placement:** new file `main/src/services/scrollbackRetention.ts`, invoked from `main/src/index.ts` after window ready. Separate module for isolation and testability.

**Expected first-run effect on profiled data:**
- Panels cleaned: 1,187 across 253 sessions (237 archived-and-old + 16 archived-with-null-last-viewed).
- Freed: ~148 MB of state payload.
- Retained: 44 recently-viewed archived sessions keep their scrollback, plus all 62 active sessions.

### 5. Forward WebGL lifecycle events to main-process log
Renderer-side `console.warn` at `TerminalPanel.tsx:428,437` is the only signal for WebGL load success, initial failure, and context loss. `/mnt/c/Users/khaza/.pane/logs/pane-*.log` contains zero hits because those files are main-process only and renderer console is not forwarded in production. Forward the three events to the main logger. No perf change on its own, but unblocks validation on the ARM box.

## Open verification before sizing fix #1

Does xterm's WebGL renderer issue GL draw calls while the host canvas element is `display: none`? If it self-gates on element visibility (IntersectionObserver or zero-bbox check), hidden-panel GPU work is already zero and fix #1 collapses to a no-op. If it does not self-gate, fix #1 becomes the single largest win for the 5-panel workload.

Resolution: read `node_modules/@xterm/addon-webgl/` render loop. Roughly a 10 minute task. Must complete before any change touching WebGL.

## Out of scope for this brief

- `/mnt/c` vs WSL-home project placement. User choice, Pane cannot force.
- Main-process polling intervals such as `gitStatusManager.ts`. Separate concern from per-panel background cost.
- Per-second `terminal:command_executed` log spam from `PanelManager`. Likely benign for battery but worth revisiting later.

## Validation plan (before / after)

On the ARM Windows dev box, with 5 Claude panels streaming tokens in the background and one foreground terminal panel.

- Windows Task Manager per-process: GPU engine %, Power usage category, CPU %.
- Pane's own logs after fix #5 lands, to confirm WebGL is actually active (not silently fell back to DOM).
- `sessions.db` size on disk over time, before and after fix #4 (retention sweep).
- Run sequence: baseline, fix #4 (retention) + fix #3 (snapshot on deactivate), fix #2 (hidden-panel batch cadence), then fix #1 (WebGL detach) if the open verification says it is needed.
