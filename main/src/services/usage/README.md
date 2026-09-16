# Transcript usage indexing

UsageManager scans all JSONL files recursively beneath `~/.claude/projects`
and `~/.codex/sessions`. This includes Claude subagent transcripts and Codex
`year/month/day` directories. Roots are rediscovered on every pass, including
when their parent directories did not exist at startup.

Indexing runs at startup, every four hours, and on manual Refresh from the usage dashboard or Settings → Usage. There are
no native usage watchers or per-transcript watch handles. Unchanged files are
checked by metadata and skipped; changed files resume from their stored cursor.
The four-hour interval is a scheduling cadence, not a maximum freshness
bound: large scans can take longer. The usage page shows the last successful
scan and keeps errors visible until a subsequent successful pass.

All indexing uses a single queue. Requests made while a scan is running coalesce
into one follow-up discovery pass. A manual refresh waits for its requested pass,
including when an earlier pass is still running. Stop clears the polling timer
and invalidates queued and in-flight work. A lifecycle generation check after
asynchronous operations prevents stopped work from updating events, cursors,
quota samples or status. Restart queues fresh discovery after old reads drain.

Tests use generated transcripts in temporary directories and in-memory SQLite.
Run them with Node 22:

```sh
pnpm --filter main exec vitest run src/services/usage
```

Do not reproduce descriptor exhaustion against a user's real transcript trees.
For resource measurements, generate a disposable tree, constrain only child
processes, and delete only fixtures created by that run.
