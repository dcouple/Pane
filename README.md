# Animation evidence — animations-for-the-pane-web-app

Before/after clips for every animation the Remote Pane PWA branch touches. Each
pair is the same interaction, same fixtures, same **390x844** viewport with touch
emulation on; the only difference is the motion code.

This is the phone-sized companion to
[`anim-evidence-feel-fast`](https://github.com/dcouple/Pane/tree/anim-evidence-feel-fast),
which holds the desktop app's clips from #480. The viewport is the reason it is a
separate capture: most of what moves in the PWA — the nav drawer, the create-pane
sheet, the terminal control keys, the scroll joystick — only exists below the
`md` breakpoint and would not appear at 1280x800 at all.

Both phases are captured with the PWA's theme fix applied — the branch also
corrects a missing theme base class that had this surface rendering a dark
palette with light-theme borders. Without that, the two halves would differ in
colour as well as motion and stop being a fair comparison; with it, the clips
also show the app as it actually ships.

Captured with Chromium's animation clock at **0.2x** — everything here plays at
one fifth of real speed, so a 240ms sheet is legible frame by frame. The `before`
clips come from `f4f3a8e` (the branch point), the `after` clips from the tip of
the branch.

`.gif` is the inline preview used in the PR table; `.mp4` beside it is the
full-resolution version. `marks.json` records, per clip, the offset the
interaction fired at and the viewport rectangle it was cropped to.

Reproduce from the branch:

    PANE_ANIM_PHASE=before pnpm anim:evidence:remote && pnpm anim:evidence:render before-remote
    PANE_ANIM_PHASE=after  pnpm anim:evidence:remote && pnpm anim:evidence:render after-remote
