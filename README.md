# Animation evidence — animations-that-make-pane-feel-fast

Before/after clips for every animation the branch touches. Each pair is the same
interaction, same fixtures, same 1280x800 viewport; the only difference is the
motion code.

Captured with Chromium's animation clock at **0.2x** — everything here plays at
one fifth of real speed, so a 180ms transition is legible frame by frame. The
`before` clips come from `b2cd4f9` (the branch point), the `after` clips from the
tip of the branch.

`.gif` is the inline preview used in the PR table; `.mp4` beside it is the
full-resolution version. `marks.json` records, per clip, the offset the
interaction fired at and the viewport rectangle it was cropped to.

Reproduce from the branch:

    PANE_ANIM_PHASE=before pnpm anim:evidence && pnpm anim:evidence:render before
    PANE_ANIM_PHASE=after  pnpm anim:evidence && pnpm anim:evidence:render after
