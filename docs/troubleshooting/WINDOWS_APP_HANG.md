# Windows freezes on startup or window focus

A September 3, 2026 report described the latest version as "lagging" and "freezing all the time." The reported investigation found a 250 MB `sessions.db`, approximately 200 MB of terminal history across 92 stopped sessions, an accidental Git repository at the Windows user profile root, and the isolated PTY host disabled. Windows recorded `AppHangTransient`.

## Prevention

- Startup loads only logs and browser panels that need restart cleanup. Terminal state is restored on demand when accessed, including history for stopped and archived sessions.
- Workspace summaries exclude raw and serialized terminal buffers in SQLite before returning rows to JavaScript. Summary reads do not replace complete cached panel state or write reduced state back to disk.
- Automatic Git status checks and filesystem watching skip the home directory, log a diagnostic, and report unknown Git status. Windows path comparison ignores case and normalizes separators and dot segments. Choose the actual project folder instead of `C:\Users\<user>`. Existing repository records and `.git` directories are not deleted.
- New configurations no longer use the home directory as an implicit Git repository. Legacy home-directory `gitRepoPath` values are rejected by the migration accessor.
- The isolated PTY host defaults to enabled on Windows, including existing configurations without a `usePtyHost` value. Explicit `false` values are preserved. Enable **Settings > Advanced > Use isolated PTY host** and restart Pane to change an existing opt-out. `PANE_USE_PTY_HOST=1` still forces it on for development.

Terminal history remains on disk. The existing 21-day retention policy for archived sessions is unchanged, and no full `VACUUM` runs during startup. A large database file does not by itself mean all history is resident in the JavaScript heap.

## Manual Windows verification

1. Use an isolated `PANE_DIR` with a copy of a database containing many stopped and archived terminal panels. Launch Pane, inspect responsiveness and heap use, then reopen an old terminal and verify its history.
2. In an isolated test profile with a home-directory Git repository, select a session whose worktree path is that home directory. Repeatedly blur/focus Pane. Confirm no recursive watcher or Git status scan starts, and check the diagnostic in the main-process log. Verify a normal project beneath the profile still refreshes.
3. Start with a config missing `usePtyHost`: confirm the settings toggle is enabled and the supervisor forks on Windows. Repeat with explicit `false`, then enable the setting and restart.

The automated tests cover persistence, summary projections, path normalization, Git scan entry points, and platform defaults. They do not reproduce Windows `AppHangTransient` or validate a packaged Windows PTY host.
