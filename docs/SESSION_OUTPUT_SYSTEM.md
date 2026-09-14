# Session Output Handling System

## Terminal panels

Terminal output belongs to each panel. `TerminalPanel` subscribes to its PTY stream and uses `terminal:getState` to restore the main process's rendered emulator state when the pane mounts again. The main process retains the raw scrollback log and headless emulator while another pane is visible. Renderer snapshots support app-restart restoration; switching panes disposes the old renderer and restores the new panel without duplicating its scrollback.

The Remote PWA reads panel output through `panels:get-output` and subscribes to panel events. Backend session output and conversation history remain available to history, export, and compatibility callers.

## Session navigation

`SessionView` and `ProjectView` subscribe to the panels and active panel for the displayed session. Session layouts and focused groups are similarly selected by session ID. Changes to another session's panels or activity do not invalidate those subscriptions; status indicators retain their own subscriptions.

`useSessionView` owns the active worktree's git actions and archive dialogs. It does not fetch session conversation output, track a second script terminal, or relay output notifications through DOM events. Those were remnants of the removed Output and Messages views. Git commit-message generation still reads saved prompts, and archiving continues to preserve the backend's histories and outputs.

## Creation preferences

Creation preferences update optimistically. Full preference snapshots are saved in edit order so a slower request cannot overwrite a newer backend snapshot. An older failed save leaves subsequent edits visible; if the latest save fails, the UI restores the last successfully saved snapshot. Reopening the creation dialog waits for pending saves before reading preferences, and a late read cannot replace a newer edit. Session count remains a per-dialog choice and is never persisted.

## Validation

- `session-navigation.spec.ts` switches worktree panes and checks active-panel persistence without obsolete session output or conversation-count requests.
- `sessionPreferencesStore.test.ts` covers queued edits, earlier and later failures, rollback to confirmed state, and dialog reloads during saves.
- Terminal lifecycle, restore, scrollback, and export tests remain the checks for durable terminal content. The session-navigation layer does not transform or delete persisted output.
