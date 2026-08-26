# UI density & chrome refresh

Goal: make Pane feel crisp and space-efficient (reference: Superset) while keeping
what makes it Pane — the theme system, agent-status signals, Pane Chat, immersive
mode. Every step is verified visually with Playwright screenshots across all
15 batch themes (`pnpm theme:screenshots` → `screenshots/themes/batch/`) plus
targeted specs, and eyeballed in `pnpm dev`.

## Verification harness (done first, reused by every step)

- Add `tests/chrome-evidence.spec.ts` (modelled on `theme-screenshots.spec.ts`)
  that captures, per theme (dark + light at minimum, all 15 for the token PRs):
  1. default layout (sidebar + session + terminal),
  2. sidebar collapsed,
  3. the `+` tab popover open (after step 6),
  4. the right inspector open (after step 5).
- Baseline screenshots are captured on `main` before any change so each PR
  ships a before/after grid.
- `pnpm theme:contrast` must stay green (border dimming can't break text/UI
  contrast gates).
- Fractional-pixel audit script: grep tokens/CSS for `1.25px`, `0.5px`,
  `translate(...%)` on panels; fail on new occurrences.

## Step 0 — Doubled terminal text (bug, blocks perceived quality)

Both screenshots show two xterm frames painted over each other. Reproduce in
`pnpm dev` (resize, theme switch, blur/refocus, sidebar toggle) and inspect the
WebGL attach/detach path in `frontend/src/components/panels/TerminalPanel.tsx`
(`loadWebglRenderer` / `disposeWebglRenderer`, ~L479–520) and the repaint
nudge from this branch. Fix, add a regression check (screenshot the terminal
after a forced resize and OCR-free diff against a clean render). Ship
separately from the design work.

## Step 1 — Flatten the chrome (tokens + CSS, all themes at once)

- Remove the "window inside a window": delete `border: 3px`, radius, shadow,
  and outer gap from `.pane-sidebar-shell` / `.pane-session-shell`
  (`frontend/src/index.css` ~L177–215 and the per-theme blocks that follow).
  Set `--app-shell-radius`, `--panel-shell-radius`, `--panel-shell-shadow` to
  0/none in every theme in `styles/tokens/effects.css` (L181–241); keep the
  synthwave/acid glow tokens only for focus rings.
- One hairline: add `--border-hairline: 1px`; replace all `1.25px` borders
  (`index.css` L478–545) and `border-2/3` on chrome with it.
- Dim dark-mode borders in `styles/tokens/colors.css`:
  `--color-border-primary` 0.08→0.06, `--color-border-secondary` 0.05→0.04,
  `--color-border-navigation` 0.06→0.05, hover 0.12→0.10. Light themes keep
  ~0.12 equivalents. Re-run `pnpm theme:contrast`.
- Panels separate by background tone + hairline; no per-panel cards.

## Step 2 — Typography

- `--font-family-sans` (`styles/tokens/typography.css:22`) → system stack
  first (`-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui,
  sans-serif`); ship Inter locally (woff2, like the Nerd Font) for
  Windows/Linux parity and drop the Sora Google-Fonts import.
- Chrome text sizes snap to integers: 11/12/13px; line-heights integer px.
- `-webkit-font-smoothing: antialiased` on dark themes only; `auto` on light.
- Terminal: keep Geist Mono default; expose JetBrains Mono / SF Mono in
  Terminal settings; ensure `fontSize`/`lineHeight` in xterm options are
  integers.
- Audit and remove non-integer transforms/positions on panel containers.

## Step 3 — Title strip + sidebar density

- New 38px title strip spanning the window (drag region), sharing the
  vertical plane with the traffic lights (`main/src/index.ts:354`,
  `trafficLightPosition`). Holds: sidebar collapse toggle, layout/split
  toggle, theme quick-switch, window title (centre), immersive toggle.
- Remove the logo/wordmark row and its `border-b` from `Sidebar.tsx`
  (~L488–500); logo lives on Home/About only.
- Sidebar: `REPOSITORIES` becomes a 20px section label; project rows 28px with
  name + branch (two-line, 12/11px) and the **agent status dot right-aligned**
  (Pane's equivalent of Superset's diff stats; show diff stats too when git
  status is available). Collapse chevrons at row end, `+` on hover.
- Footer (Remote · Feedback · version · Docs) collapses to one 24px row.
- Update `tests/sidebar-compact.spec.ts` and `window-title-bar.spec.ts`.

## Step 4 — Center becomes tool tabs only

- Tab bar: 32px, tabs are text + status dot, no pill backgrounds; active tab
  = brighter text + 2px bottom indicator (`--tab-indicator-*` already exists,
  `index.css:164`).
- Remove the "Add Tool ▾" right-aligned control and the bottom preset chip
  row (`SessionView.tsx` ~L1735–1758) — both replaced by step 6. Keep an
  opt-in "Show preset bar" setting for people who like the chips.

## Step 5 — Right-side inspector (Explorer / Review) — DONE (option A)

The existing right Details panel is the inspector: **Details · Files ·
Changes** (`InspectorTabs.tsx`). Files hosts the Explorer panel, Changes
hosts the Review panel with a file-count badge; both stay mounted so their
state survives tab switches. Explorer/Review leave the tab strip, the
strip's `⌘⇧1-9` indexes and split groups only see working panels, and a
persisted active Explorer/Review from before the move just selects the
matching inspector tab. Immersive mode is no longer keyed to them. The
rail defaults to 360px (240–720) and is shown by default; inside it the
Explorer and Review switch to a stacked layout below 600px via a container
query. Applied to both `SessionView` (worktrees) and `ProjectView` (main
repo).

Files opens files as center `editor` tabs with VS Code semantics
(`services/openFileInEditor.ts`): single-click → one preview tab per
session (italic title, re-targeted by the next single-click); double-click
in the tree or on the tab, or editing the file → pinned. A file already
open is focused, not duplicated. The Explorer's Monaco half became
`FileEditorView` (used by `FileEditorTabPanel`); the Files tab is tree-only
and highlights the active tab's file. Review "Open in editor" and terminal
file links open pinned tabs; `editor` never appears in the `+` menu.

## Step 6 — `+` tab button and Superset-style popover

- `+` next to the last tab. Popover (Radix-style, 1px hairline, 6px radius,
  no shadow in flat themes):
  `Terminal ⌘T · Browser ⌘⇧B · Editor ⌘E · ─ · Presets ▸ · ─ · Show preset bar
  · ✓ Use compact button`. Presets submenu lists configured CLIs with brand
  icon and `^1…^9`, then "Configure presets…" (opens Settings).
- Reuse the existing Add-Tool commands (`SessionView.tsx:654`) so the palette
  and the popover share one list.
- Add `tests/tab-popover.spec.ts` (keyboard nav + screenshot).

## Step 7 — Hotkey legibility

- `components/ui/Kbd.tsx`: add an `inline` variant — plain muted text,
  11px, tabular numbers, symbols `⌘ ⇧ ⌥ ^`, no border/box. Default for menus,
  popovers, tooltips, command palette; the boxed variant only in Settings /
  Help.
- Right-align shortcuts in every dropdown; run `dropdown-keyboard-nav.spec.ts`.

## Step 7b — Remove chrome animations

- No transitions on layout: sidebar collapse/expand, inspector/terminal rail
  reveal, tab switches, popovers open instantly (Superset behaviour). Delete
  `pane-reveal` / `transition-[width] duration-reveal` classes
  (`SessionView.tsx:1775` and siblings) and the reveal keyframes in
  `index.css`; keep only functional motion (spinner, agent-status pulse).
- `--duration-*` tokens in `effects.css` stay for those two cases; everything
  else uses `transition: none`.
- Retire `anim:evidence` specs that exist only to prove reveal timing
  (`tests/anim-evidence*.spec.ts`, `motion*.spec.ts`) or convert them to
  assert "no transition" on chrome elements.

## Step 8 — Theme identity pass

- Now that all themes share one flat chrome, re-express each theme's
  personality through accent, terminal palette, and the active-tab indicator
  colour only. Regenerate `screenshots/themes/batch/` and review the grid.

## Cross-cutting additions

- **Empty state = the `+` popover inline.** Replace "⚡ No Active Panel"
  (`SessionView.tsx:1707`) with the Terminal / Browser / presets list and
  their hotkeys so a new session is one keystroke from running.
- **Command palette registration.** `CommandPalette.tsx` already exists;
  every new action (new tab, presets `^1…^9`, toggle inspector ⌘⇧E, theme
  switch) is registered there with its hotkey label. No new palette work.
- **Scrollbars.** 6px overlay scrollbars, thumb visible on hover only, token
  colours; applied globally in `index.css`.
- **Interaction states as one system.** hover = 4% surface tint,
  active = 8%, focus = 1px accent ring. Replace per-component variants.
- **Windows/Linux caption bar.** Mirror the new title-strip height/colour in
  `main/src/utils/windowControlsOverlay.ts` in step 3.
- **Settings density.** Re-space Settings with the same tokens in step 8
  (`screenshots/settings-*.png` as before/after).

## Open decisions

- Collapsed sidebar: keep the 48px icon rail (recommended — agent-status
  dots per project) vs. collapse fully like Superset.
- Theme count: promote 4–5 core themes; mark the rest experimental in the
  picker.

## Out of scope

- Superset-style Workspaces / Tasks / PRs navigation — not Pane's model.

- Terminal renderer changes beyond step 0.
- Remote/PWA layout (`remotePwaMock.ts` paths) — follow-up.

## PR sequencing

0 (bug) → 1+2+7b (tokens/fonts/no-animation, one PR) → 3 → 4+6 (one PR) → 5 → 7 → 8.
Each PR ships the before/after theme grid from the evidence spec.
