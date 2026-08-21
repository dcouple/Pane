# Mission Control evidence — mission-control

A capture of Mission Control with several Claude Code agents running at once in
a scratch repository (`mc-demo`) on an isolated `PANE_DIR`.

Re-captured from the branch tip after the fitting work: tile content is now
scaled to fit the tile rather than clipped, and the column count is capped by
what the window can carry, so a 1440-wide window lays out two wide columns for a
3x request rather than three narrow ones.

The clip runs a scripted tour of the view: the grid settling with live tiles,
regrouping by status and back to project, one tile promoted to a live terminal
under the pointer, then two columns and back to three.

`clips/mission-control.gif` is the inline preview used in the PR;
`clips/mission-control.mp4` beside it is the full-resolution version, and
`clips/mission-control.png` is a full-resolution still of the hovered tile
rendering live.

Captured at a 1440x900 viewport from a development build of the PR head, driven
over the Chrome DevTools Protocol; the frame rate is the capture rate of that
screenshot loop, about 7 frames per second, and playback matches real time.
