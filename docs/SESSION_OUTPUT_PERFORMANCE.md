# Session output audit

This audit builds on the startup and Git-scan fixes in #591. It targets work
repeated during terminal activity and history loading, without changing
terminal rendering, scrollback limits, or database schema.

## Changes

- `App`, `HomePage`, and `useIPCEvents` subscribe to the session fields/actions
  they use. Updating the separate terminal output buffer no longer schedules
  either top-level component to render. The event hook's unused fake socket
  return value and unused action dependency are removed.
- Prompt markers use an indexed SQLite `COUNT(*)` instead of materializing
  every output payload to read the array length. Both existing marker offset
  conventions are preserved, and the count includes every output type.
- Session history loading reads backward, retaining the newest 300 text
  outputs and 100 JSON messages independently, then restores chronological
  order. The old synchronous “batching” loop never yielded and could stop
  before reaching the newest messages. Normalization now runs only for
  retained JSON messages. Late history for a deleted session is ignored.
- Panel JSON is decoded at the database boundary, including legacy
  string-wrapped state/metadata. This also fixes legacy state throwing before
  the active-panel flag could be assigned. The manager no longer performs
  two exception-driven string checks per panel or repeats JSON parsing.
  Malformed legacy serialized values retain a fallback, while archived-panel
  cache guards and summary reads that omit scrollback are preserved.

## Measurements

Local Linux measurements with Node 22.18.0, compared with `80b8b621` (v2.4.100).
These are isolated measurements, not an end-to-end application speedup claim.

| Workload | Before | After |
| --- | ---: | ---: |
| Count 10,000 output rows with 78.125 MiB of payload, median of 9 reads | 253.476 ms | 0.353 ms |
| Heap growth during those reads, median of 9 | 83.772 MiB | 0.001 MiB |
| App renders recorded during 100 background output chunks | 100 | 0 |
| HomePage renders recorded during the same burst | 64 | 0 |
| Output chunks retained after the burst | 100 | 100 |

The SQL benchmark warms both paths and requests GC before each measured read.
Heap growth measures temporary JavaScript allocation, not retained memory or
total process RSS. React Scan records component renders in a development
Chromium renderer with mocked Electron IPC; it does not measure native PTY,
xterm/WebGL, or packaged Windows performance.

## Reproduce

Use the repository's supported Node/pnpm toolchain and a SQLite native module
built for that Node version.

```bash
pnpm build:main
node --expose-gc scripts/benchmark-session-output.js
pnpm --filter frontend test src/stores/sessionStore.test.ts
pnpm --filter main test --run src/database/database.panel-loading.test.ts src/services/sessionManager.output-count.test.ts
PANE_REACT_SCAN=1 pnpm test -- tests/session-output-perf.spec.ts --workers=1
```

The render check requires a fresh dev server started with `PANE_REACT_SCAN=1`;
an already-running server without that option cannot produce the evidence.
The check is opt-in so ordinary Playwright runs do not require React Scan.
The benchmark creates and removes its own temporary database.

## Verification

- All 334 frontend unit tests passed.
- Full main unit run: 910 passed, 2 skipped, 15 failed. All 15 failures were
  Unix-socket `EPERM` errors in `daemon/server.test.ts` and
  `permissionIpcServer.test.ts`; the same 15 failures reproduced on unchanged
  `80b8b621` in this environment.
- Chromium: render regression and two renderer startup smoke checks passed.
  The render regression failed on the baseline as expected. The new history
  and legacy-panel assertions also failed on the baseline and passed with
  these changes.
- Root lint and typecheck passed. Lint reports five existing unused-variable
  warnings in `skillCacheManager.ts`.

The browser checks used a Vite-only Playwright web server with the repository's
Electron API mock. Native desktop/Windows interaction was not exercised.
