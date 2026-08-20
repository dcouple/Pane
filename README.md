# Mission Control evidence — mission-control

A capture of Mission Control with four Claude Code agents running at once, plus
the Pane Chat agent, in a scratch repository (`mc-demo`) on an isolated
`PANE_DIR`.

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
