# Brief: Wire Play button to unified run script resolution

## Why
The PanelTabBar Play button currently only checks for `scripts/pane-run-script.js` in the worktree. The pane.json config detection we just built (detecting pane.json, conductor.json, .gitpod.yml, devcontainer.json) feeds into a `projects:run-script` IPC handler that is dead code — no frontend button calls it. Users have zero visibility into which run script will execute, and the new config detection isn't wired to anything they actually click.

## Context

### Current Play button behavior (PanelTabBar.tsx:382-400)
```typescript
const handleRunDevServer = useCallback(async () => {
  const scriptExists = await window.electronAPI?.invoke('file:exists', {
    sessionId: session.id,
    filePath: 'scripts/pane-run-script.js'
  });
  if (scriptExists) {
    handleAddPanel('terminal', {
      initialCommand: 'node scripts/pane-run-script.js',
      title: 'Dev Server'
    });
  } else {
    handleAddPanel('terminal', {
      initialCommand: `claude --dangerously-skip-permissions "${buildSetupRunScriptPrompt(...)}"`,
      title: 'Setup Run Script'
    });
  }
}, [...]);
```
- Checks for `scripts/pane-run-script.js` via `file:exists` IPC
- If found: runs in terminal panel
- If not found: asks Claude to generate a run script
- Completely disconnected from pane.json detection and DB run_script

### Dead code
- `projects:run-script` IPC handler in `main/src/ipc/project.ts:531-613` — has the detection fallback but no frontend calls it
- `projects:get-running-script` and `projects:stop-script` — also unwired
- These use logsManager execution (different from terminal panel execution the Play button uses)

### Existing detection service
- `main/src/services/projectConfigDetector.ts` — `detectProjectConfig()` already resolves pane.json > conductor.json > .gitpod.yml > devcontainer.json
- Returns `DetectedProjectConfig` with `run`, `setup`, `archive`, `source` fields

### Key files
- `frontend/src/components/panels/PanelTabBar.tsx:382-400, 823-829` — Play button handler and rendering
- `main/src/services/projectConfigDetector.ts` — detection service (already built)
- `main/src/ipc/project.ts` — project IPC handlers
- `main/src/preload.ts:357-359` — project IPC methods exposed to renderer
- `frontend/src/components/ui/Dropdown.tsx` — existing dropdown component (for future split-button)
- `frontend/src/components/ui/Tooltip.tsx` — existing tooltip component
- `frontend/src/components/ProjectSettings.tsx` — settings UI

### Execution model
The Play button runs commands in a **terminal panel** via `handleAddPanel('terminal', { initialCommand })`. This is different from the dead `projects:run-script` which uses `logsManager.runScript()`. The terminal panel approach should stay — it's the established UX.

## Decisions

- **New IPC `projects:resolve-run-script`** — backend resolves the run script using the full hierarchy, returns `{ command, source }` or null. Resolution order: DB `run_script` > pane.json > conductor.json > .gitpod.yml > devcontainer.json > `scripts/pane-run-script.js` exists check > null. This keeps resolution logic in one place on the backend.

- **PanelTabBar Play button calls this IPC** — replaces the inline `file:exists` check. Gets the resolved command, runs it in terminal panel as today. Execution model unchanged.

- **Keep `scripts/pane-run-script.js` as last fallback** — existing users who have this file aren't broken. It's just the lowest-priority source now.

- **Play button tooltip shows source** — "Run: pnpm dev (from pane.json)" so users know what will execute.

- **When nothing is resolved, show a helpful message** — instead of launching Claude to generate a script, show what config files are supported (pane.json, etc.) and link to settings.

- **Add JSDoc on the IPC** documenting the resolution cascade clearly.

- **Don't touch the dead `projects:run-script` IPC** — leave it for the future run service consolidation (Dcouple-Inc/Pane#106).

## Rejected Alternatives

- **Refactor PanelTabBar to call dead `projects:run-script` IPC** — rejected because it uses logsManager (different execution model) and would require reconciling two different execution paths. Simpler to create a resolution-only IPC and keep terminal panel execution.

- **Add detection logic directly in frontend** — rejected because it would duplicate backend resolution logic and can't do WSL-aware file detection.

- **Full run service consolidation now** — rejected, tracked in Dcouple-Inc/Pane#106 for later. Too much scope.

## Direction

Create a `projects:resolve-run-script` IPC that returns the resolved run command and its source using the full detection hierarchy. Wire the PanelTabBar Play button to call this IPC instead of doing its own `scripts/pane-run-script.js` check. Show the source in the tooltip. Keep terminal panel execution unchanged. Document the cascade in JSDoc.
