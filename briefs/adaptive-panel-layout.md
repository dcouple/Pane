# Brief: adaptive outer-panel sizing

## Outcome

Make the worktree and main-repository inspector (Details / Files / Changes) fit
the current session workspace without losing a user's preferred width. Give the
default-layout bottom terminal a visible full-width separator and open it at
32% of usable session height when no manual preference exists. Window resizing
may temporarily constrain either surface, but must not overwrite the remembered
preference.

Root-cause decision: treat this as a sizing-contract change, not just a new
default and border. The root cause on `origin/main` is that persisted preferred
size and currently renderable size are one fixed pixel value, while the hooks do
not observe their flex container. Changing `200` to a percentage or painting a
separator alone would fix the symptoms and leave stale stored sizes, narrow
windows, and the swapped layout broken.

Baseline: freshly fetched `origin/main` at `169f8aa3` (`release: v2.4.87`,
2026-08-28).

## Current-state evidence

- `useResizable` reads a numeric local-storage value once, otherwise uses a
  fixed default; it persists every state value, including the default, and only
  applies fixed min/max bounds during mouse movement. Its right-edge math is
  based on `window.innerWidth`, not the owning container
  (`frontend/src/hooks/useResizable.ts:18-40,42-75`).
- `useResizableHeight` has the same preferred/effective-size conflation. It
  defaults and persists immediately, clamps only during an active mouse drag,
  and has no window or container observer
  (`frontend/src/hooks/useResizableHeight.ts:16-38,40-72`).
- `SessionView` supplies the worktree inspector with fixed `360 / 240 / 720`
  pixel bounds and stores it globally under `pane-detail-panel-width`
  (`frontend/src/components/SessionView.tsx:1408-1415`). `ProjectView` repeats
  that behavior under a separate key
  (`frontend/src/components/ProjectView.tsx:64-93`).
- The default bottom terminal is fixed at `200 / 100 / 500` pixels and uses
  `pane-bottom-terminal-height`; the swapped right terminal and bottom detail
  panel have separate fixed bounds and keys
  (`frontend/src/components/SessionView.tsx:1505-1527`). A new profile starts
  with the terminal collapsed, while the collapse state is also global and
  persisted (`frontend/src/components/SessionView.tsx:1545-1557`).
- The bottom dock renders the stored height directly. Its only resize affordance
  is an empty, right-aligned element inside the header, so there is no visible or
  full-width drag boundary (`frontend/src/components/SessionView.tsx:1887-1938`).
- The vertical inspector also renders its width directly. Its four-pixel handle
  has an extended pointer region but no separator semantics or keyboard path
  (`frontend/src/components/DetailPanel.tsx:136-144`). The horizontal detail
  variant has separator semantics but is deliberately removed from the tab order
  and remains mouse-only (`frontend/src/components/HorizontalDetailPanel.tsx:89-105`).
- `SessionView` has a named `.pane-session-content` flex row, but `ProjectView`
  has an anonymous equivalent. Existing shell CSS gives the named content row
  `min-height: 0`, while only `.pane-session-shell` gets `min-width: 0`
  (`frontend/src/components/SessionView.tsx:1816-1960`,
  `frontend/src/components/ProjectView.tsx:388-460`,
  `frontend/src/index.css:186-202`). The implementation must add explicit
  measurement refs/classes and min-size CSS in both views rather than assume a
  window measurement represents the workspace.
- Shell-size preferences are renderer-local UI preferences, distinct from split
  group layout persistence. Split proportions are stored per session in
  `sessions.panel_layout` and written only after an Allotment drag ends
  (`shared/types/panels.ts:382-405`,
  `frontend/src/components/panels/SplitLayout.tsx:201-220`,
  `frontend/src/components/SessionView.tsx:142-214`,
  `main/src/ipc/panels.ts:488-554`). This work must not add outer dock sizes to
  that database layout.
- Terminal xterm instances already observe their rendered container and refit
  when its size changes (`frontend/src/components/panels/TerminalPanel.tsx:1772-1789`),
  so the outer layout should change container geometry and let that existing path
  perform the terminal refit.

## Required sizing contract

All measurements come from the immediate layout container's content box
(`ResizeObserverEntry.contentBoxSize`, with `contentRect` fallback), not from
`window.innerWidth` or hard-coded title/tab offsets. Floor the observed content
box to an integer before deriving caps and floors; all subsequent inputs and
outputs are integer CSS pixels. Keep two values: `preferredPx` (user intent) and
`effectivePx` (safe rendered size). Automatic clamping changes only
`effectivePx`.

### Right inspector

Let `W` be the width of `.pane-session-content`, including the editor and visible
inspector but excluding the app sidebar. Keep the existing preferred default,
minimum, and hard maximum: `D0 = 360`, `Dmin = 240`, `Dmax = 720`. Reserve
`EminW = 320` for the editor stage and require `Dusable = 96` before rendering
interactive inspector content.

```text
rawCap = max(0, min(Dmax, W - EminW))
cap    = rawCap >= Dusable ? rawCap : 0
floor  = min(Dmin, cap)
base   = remembered preferredPx, otherwise D0
effective inspector width = round(clamp(base, floor, cap))
```

Hidden remains exactly `0` without modifying `preferredPx`. If the window becomes
too narrow to satisfy both minima, editor preservation wins and the inspector may
shrink below 240; it must not overflow or force horizontal page scrolling. When
space returns, the same preferred width returns automatically. Apply the same
contract and constants to both `SessionView` and `ProjectView`.

If any outer surface resolves to `effectivePx === 0`, keep its logical
visible/collapsed preference unchanged but render its content hidden, inert,
`aria-hidden`, and inactive for panel lifecycle purposes. It must contribute no
focus targets until space returns.

### Bottom terminal in the default layout

Let `H` be the height of the center column inside `.pane-session-content`; this
already excludes the 38px window title strip and the panel tab bar. The terminal
height includes its 32px header. Use `Tmin = 100`, collapsed header `C = 32`,
minimum usable header-plus-body `Tusable = 64`, and reserve `EminH = 160` for
the editor.

```text
rawCap = max(0, min(H, max(C, H - EminH)))
cap    = rawCap >= Tusable ? rawCap : min(C, H)
floor  = cap >= Tusable ? min(Tmin, cap) : cap
base   = remembered preferredPx, otherwise round(0.32 * H)
effective expanded terminal height = round(clamp(base, floor, cap))
effective collapsed height = min(C, H)
```

Thus an unconstrained first expansion is 32% of usable workspace height, not 32%
of the Electron window. For `H >= 192`, resizing preserves at least 160px of
editor height; below that emergency threshold, avoiding overflow wins. There is
no arbitrary 500px ceiling: the available workspace and editor reserve are the
safety bound.

When the expanded terminal's `rawCap` is below 64px, render only the 32px header
(or the available `H`); make the xterm body hidden, inert, and inactive until
room returns. Keep
the logical expanded state and preferred size unchanged, so this emergency
chrome-only state reverses automatically.

### Swapped layout

Use the same measured `W`, preferred/effective model, and `EminW = 320` for the
swapped right terminal. Preserve `R0 = 350`, `Rmin = 200`, and hard maximum
`Rmax = 600`; require `Rusable = 96` before rendering interactive terminal
content:

```text
rawCap = max(0, min(Rmax, W - EminW))
cap    = rawCap >= Rusable ? rawCap : 0
floor  = min(Rmin, cap)
base   = remembered preferredPx, otherwise R0
effective right-terminal width = clamp(base, floor, cap)
```

For the expanded swapped bottom detail panel, measure the same center-column
`H`, reserve `EminH = 160`, retain `B0 = 200`, `Bmin = 80`, `Bmax = 400`, use
the 32px inspector tab strip as `Bchrome`, and require `Busable = 64` for tab
strip plus body:

```text
rawCap = max(0, min(Bmax, H, max(Bchrome, H - EminH)))
cap    = rawCap >= Busable ? rawCap : min(Bchrome, H)
floor  = cap >= Busable ? min(Bmin, cap) : cap
base   = remembered preferredPx, otherwise B0
effective bottom-detail height = clamp(base, floor, cap)
```

Its collapsed height remains its measured, content-driven header height capped
to `H`, because that header can wrap. When `rawCap` is below 64px,
preserve the selected inspector tab and render only its tab strip; make the body
content inert and inactive until room returns. The PanelTabBar toggle remains
outside this surface and provides the reachable collapse control. The collapsed
separator is absent. The 32% first-open rule applies only to the bottom terminal
in the default layout.

## First open, remembered behavior, and migration

- Preserve the existing visibility, active inspector tab, layout-swap, and
  collapse keys. A fresh profile still starts with the terminal collapsed; its
  first expansion uses the current `0.32 * H` result.
- Preserve orientation-specific state on layout-swap round trips rather than
  transferring it: `pane-terminal-collapsed` controls only the default bottom
  terminal, the swapped right terminal remains shown, `pane-detail-collapsed`
  controls only the swapped bottom detail, and default inspector visibility
  remains governed by `pane-detail-panel-visible`.
- Introduce companion v2 keys: `pane-detail-panel-width:v2`,
  `pane-project-detail-panel-width:v2`, `pane-bottom-terminal-height:v2`,
  `pane-right-terminal-width:v2`, and `pane-bottom-detail-height:v2`. Leave the
  legacy numeric keys in place for downgrade safety.
- A valid v2 value is `{ "version": 2, "preferredPx": <integer> }`. Require
  `preferredPx` in `1..8192`, then apply the surface's current cap at render
  time. Invalid JSON, unknown versions, non-integers, and out-of-range values are
  ignored.
- Write v2 only after a pointer drag completes or a keyboard resize command
  commits. Do not write on mount, expand/collapse, layout swap, or automatic
  container clamping.
- If no valid v2 value exists, accept a legacy value only when the entire string
  is a base-10 integer inside that old surface's min/max bounds and it differs
  from the old default. Use it as an in-memory preference, but do not rewrite it
  to v2 until the next user resize. The ambiguous defaults are `360` for each
  inspector, `200` for the bottom terminal, `350` for the swapped right terminal,
  and `200` for the swapped bottom detail panel. Because `origin/main` writes
  defaults without user action, treat those exact values as unset. This
  intentionally gives existing default-state users the new behavior while
  retaining clearly customized sizes.
- Legacy keys are read-only: never update or delete them. A successful user
  resize writes only v2, after which the valid v2 value takes precedence. If v2
  is invalid, fall back to a valid migratable legacy value, then to the surface
  default/responsive rule.
- Preferences remain global per surface, as they are today. Do not put them in
  `SessionPanelLayout` or `sessions.panel_layout` and do not make them per pane.

## Separator and input behavior

- Replace ad hoc outer handles with a small shared separator primitive where
  practical. The expanded bottom terminal separator spans the entire editor/
  terminal boundary, with a one-pixel always-visible rule and at least an
  eight-pixel-high centered pointer hit band. Use pointer events, pointer capture,
  `touch-action: none`, and the row-resize cursor. The collapsed dock keeps the
  visible top rule but is not presented as an adjustable separator.
- Use theme border tokens: subtle at rest, stronger on hover/active, and a
  clearly visible focus treatment. Do not introduce a theme-specific hard-coded
  color or make the whole eight-pixel hit band visibly thick.
- Expose interactive handles as focusable `role="separator"` elements with
  `aria-orientation`, a surface-specific label, and current/min/max values.
  Arrow keys change by 10px, Shift+Arrow by 50px; Home and End select the current
  effective minimum and maximum. Up grows a bottom surface and Down shrinks it;
  Left grows a right-side surface and Right shrinks it. Each effective-changing
  keydown, including key repeat, derives from the current `effectivePx` and
  commits the resulting effective value once.
- Pointer drags snapshot `effectivePx` at pointer-down and apply movement deltas
  to that snapshot. Use only the final signed primary-axis delta from the start
  coordinate: `startY - currentY` for bottom surfaces and `startX - currentX`
  for right-side surfaces; ignore orthogonal movement and do not accumulate path
  length. Round `startEffective + delta` to the nearest integer, then clamp it to
  the current effective floor/cap as the tentative drag value. Recompute that
  tentative value from the same signed delta whenever container bounds change.
  On pointer-up, persist it as the new `preferredPx` only if the final signed
  delta is nonzero and it differs from resolving the pointer-down preference
  against the latest bounds. This
  means a user who resizes while an old preference is window-constrained
  deliberately replaces that old preference rather than adjusting an invisible
  value, while an observer-only clamp is never mistaken for user intent.
  Boundary key presses, clicks without a size change, and zero-delta drags are
  no-ops and do not write storage.
- Every non-committing pointer-up re-renders the pointer-down preference through
  the latest bounds; it never leaves the tentative drag value or an observer-only
  clamp as hidden user intent.
- `pointerup` commits and restores pointer/cursor/text-selection state.
  `pointercancel` re-resolves the pointer-down preference against the latest
  container bounds without writing; `lostpointercapture` performs the same
  rollback unless a preceding pointer-up already committed. Pointer capture must
  make release outside the window safe.
- Do not render `role="separator"` at all when its surface is hidden, collapsed,
  immersive, or when `floor === cap` (including a zero-range container). Any
  retained boundary rule is decorative and `aria-hidden`. Do not persist
  Home/End or drag results for a non-adjustable range. When a surface is
  logically hidden, immersive, or zero-sized, explicitly make its outer content
  root inert and `aria-hidden`, and pass inactive state to hosted panels; do not
  rely on width/height zero to remove descendants from the tab order.
- A nonzero `floor === cap` surface remains visible and active unless it meets a
  separately defined chrome-only rule; it simply has no interactive separator.
- Add explicit accessible names to terminal expand/collapse controls; preserve
  focus and prevent text selection while dragging.

## Scope

- Container-aware preferred/effective sizing utility or hook.
- Worktree and main-repository vertical inspectors.
- Default bottom terminal, plus safety parity for the swapped outer surfaces.
- Versioned local-storage migration, shared accessible separator behavior,
  targeted unit/E2E coverage, and visual evidence.

## Non-goals

- Changing sidebar sizing, internal Allotment split behavior, or database layout
  schemas.
- Redesigning Details / Files / Changes content, terminal headers, tabs, or the
  layout-swap feature.
- Remote PWA layout, mobile/touch UI redesign, xterm rendering internals, or
  adding a Settings control/reset action for sizes.
- Matching unspecified Superset colors or chrome; the supplied direction is used
  for the terminal's roughly one-third geometry only.

## Acceptance criteria

- With no valid v2 or migratable legacy terminal preference, first expansion is
  `32% +/- 2px` of measured usable height whenever neither the minimum floor nor
  editor-reserve cap constrains it.
- Pointer or keyboard resizing survives collapse/re-expand, session switching,
  layout switching where applicable, reload, and app restart.
- Shrinking the window constrains the visible surface without changing the
  stored preference; growing it restores that preference exactly, subject to the
  current cap.
- When `W >= 320`, the inspector/right terminal leaves at least the
  formula-required 320px for the editor; when `H >= 192`, a bottom surface leaves
  at least 160px of editor height while expanded. Collapsed bottom-detail chrome
  is content-driven and exempt from that expanded-body reserve. Below those
  thresholds, neither surface becomes negative, exceeds its container, or
  creates page-level overflow.
- Worktree and main-repository inspectors obey identical rules while retaining
  their separate preferences.
- The expanded terminal has an always-visible, full-width separator whose visual
  and hit areas meet the contract above. All interactive separators expose
  correct ARIA values, keyboard controls, cursor, and focus styling.
- Hidden, collapsed, and immersive surfaces contribute no separator to the tab
  order or accessibility tree.
- A logically visible surface constrained to zero makes all hosted content inert
  and inactive without erasing visibility, active-tab, collapse, or size
  preferences; it restores when space returns.
- Width raw caps below 96px resolve to zero; bottom raw caps from 32px through
  63px resolve to a 32px chrome-only surface. A nonzero fixed range at or above
  the usable threshold remains active but exposes no separator. No active
  one-pixel body or focus target appears around a reserve threshold.
- Existing inspector visibility/tab, terminal collapse, split-group persistence,
  layout swap, and active xterm resizing behavior do not regress.

## Tests

- Unit-test a pure sizing resolver: first-open ratios, nominal bounds, undersized
  containers, preferred-size restoration after shrink/grow, rounding, separator
  eligibility, and immersive/hidden/zero/chrome-only render policy.
- Unit-test the storage contract across all five surfaces: valid-v2 precedence,
  invalid-v2 legacy fallback, ambiguous old defaults, strict legacy bounds, no
  writes on mount/expand/swap/clamp/no-op input, v2-only writes after commit, and
  unchanged legacy keys.
- Add `tests/adaptive-panel-layout.spec.ts` with a mocked worktree session to
  measure the 32% first expansion, pointer-drag and keyboard resize, persisted
  reload, storage unchanged across viewport constraint, restored size after
  regrowth, collapsed and chrome-only behavior, ARIA state, separator hit
  geometry, zero-sized and logically hidden inertness, pointer cancellation, and
  release outside the viewport. Exercise Shift+Arrow, Home/End, key repeat,
  boundary no-write, and lost-pointer-capture cleanup. Cover immersive render
  policy in the unit layer because `origin/main` exposes no user-reachable
  immersive trigger (`frontend/src/components/SessionView.tsx:1430-1442`).
- Add a constrained-drag regression: start with a preference above the current
  cap, drag from the effective size, regrow the container, and verify the newly
  dragged preference restores instead of the old hidden value.
- During a drag, change container bounds with both zero and nonzero pointer
  displacement; observer-only changes and zero displacement must not persist,
  cancellation must re-resolve safely, and genuine pointer intent must commit.
- Cover both worktree and main-repository inspector widths, narrow and short
  viewports, and the swapped layout safety path. Assert editor reserve when the
  container is large enough and no document overflow at emergency sizes.
- Bind all five surfaces in integration coverage. For each, assert separator
  orientation and growth direction, ARIA min/max/current values, and that a
  committed resize writes only its matching v2 key; exercise pointer input on at
  least one surface per axis and keyboard input on the others.
- At a constant viewport, expand/collapse the app sidebar to prove sizing follows
  the immediate container and restores the exact preference when space returns.
- Verify browser reload persistence in Playwright. Manually run one real Electron
  quit/relaunch check using the same temporary `--pane-dir` and temporary
  `--user-data-dir` arguments for both launches so Chromium local storage
  actually persists without touching the user's profile;
  `scripts/pane-drive.mjs:4-18` demonstrates both arguments.
- Keep `tests/review-availability.spec.ts` and the session-shell axe scan green
  (`tests/accessibility.spec.ts:345-372`). Run the focused spec, frontend unit
  tests, `pnpm lint`, and `pnpm typecheck`.

## Visual QA matrix

| Window | State | What to inspect |
| --- | --- | --- |
| 1400x900 | Fresh profile; terminal first expanded; Details then Changes | One-third terminal geometry, full-width rule, inspector at 360px |
| 1024x640 | Sidebar expanded; large remembered inspector/terminal | Safe clamping, editor reserves, no clipped controls |
| 800x500 | Sidebar collapsed; default and swapped layouts | Emergency constraints, no page overflow, usable collapse controls |
| 320x220 synthetic | Sidebar collapsed; visible outer surfaces | `W < 320` / `H < 192`, inert zero-range/chrome-only content, reachable collapse control |
| 1920x1080 | Resize small -> constrained -> large | Exact preferred-size restoration without jumps |
| 1400x900 | Main-repo Files/Changes inspector | Same rail behavior with its separate preference |

Repeat the core 1400x900 and constrained cases in one dark theme, one light
theme, and high-contrast mode; verify rest, hover, drag, and keyboard-focus
separator states. Spot-check macOS hidden-inset and Windows/Linux window-controls
overlay builds because their title chrome differs even though container-derived
math should not.

## Risks, dependencies, and assumptions

- **Migration ambiguity:** exact legacy defaults cannot be distinguished from a
  manual resize to the same number. Assumption: adopting the new default is more
  important for those ambiguous values; all non-default legacy values are kept.
- **Resize feedback:** observing the same container whose child size changes can
  loop or jitter. The implementation must derive an idempotent integer result,
  avoid storage writes from observer callbacks, and update React state only when
  the effective value changes.
- **Transitions/xterm:** remove width/height transitions from the targeted outer
  surfaces for drag and observer-driven size changes; a stale starting pixel
  value can otherwise violate the new cap during interpolation. Non-layout hover
  and focus feedback may still animate. Terminal fitting remains owned by the
  existing xterm observer.
- **Reference:** no Superset asset is stored in this checkout. Assumption: the
  prompt's 32% measurement is authoritative; visual matching beyond geometry
  requires the reference to be supplied during QA.
- No new runtime dependency or main-process/database change is expected.
- **Scope assumption:** the shared container-aware preferred/effective-size
  contract is the intended root-cause fix. A defaults-only interpretation would
  require reopening and narrowing this brief before implementation.
