# Sessions

Sessions are the named, ongoing conversations where work intent lives. A
Session keeps the goal, context, decisions, blockers, evidence, outputs, and
next action together while one or more existing or new Panes provide the
focused work surfaces. A tab shares its parent Pane's worktree.

In the sidebar, `+` opens an agent picker and an optional chat name field. Pane
remembers the chosen agent as the default for future Sessions while existing
Sessions keep their own agent. A blank name receives a generated name such as
`New chat` or `New chat 2`; each new Session opens as one Pane Chat and can be
renamed later from the optional read-only overview. Expand a Session to see
its associated Panes and open any Pane in its existing sidebar view.

The Session owns discussion, read-only code exploration and investigation,
clarification, and ticket creation or revision. After a ticket is ready and
the user explicitly authorizes implementation, the Session delegates
`astra-ticket` through RunPane in an appropriate existing Pane or tab, or
creates one when needed. The delegated skill owns its model, planning,
implementation, pull request, review, QA, and CI requirements. The Session
keeps its selected agent, profile, and tool configuration; selecting a Session
agent does not replace the delegated workflow's model requirements.

Sessions do not create worktrees and do not edit project implementation files.
An association identifies work that a Session coordinates; it does not grant
implementation authority by itself. Detach a Pane before assigning it to a
different Session.

## Stable interfaces

The shared record and service are:

- `shared/types/orchestrationSession.ts`
- `main/src/services/orchestrationSessionManager.ts`
- `orchestration-sessions.json` below `PANE_DIR`

The daemon and Electron IPC channels are:

`orchestration-sessions:list`, `orchestration-sessions:select`,
`orchestration-sessions:create`, `orchestration-sessions:get`,
`orchestration-sessions:update`, `orchestration-sessions:set-agent`,
`orchestration-sessions:associate`, `orchestration-sessions:detach`, and
`orchestration-sessions:overview`.

Selectors accept a stable Session ID or an exact Session name. The existing
`pane-chat:*` channels remain compatibility endpoints for the imported legacy
conversation.

RunPane exposes the corresponding commands:

```text
runpane sessions list --json
runpane sessions get --session <session-id-or-name> --json
runpane sessions overview --session <session-id-or-name> --json
runpane sessions create --from-json <path|-> --json
runpane sessions update --session <session-id-or-name> --from-json <path|-> --json
runpane sessions set-agent --session <session-id-or-name> --agent <agent> --json
runpane sessions associate --session <session-id-or-name> --pane <pane-id> --json
runpane sessions detach --session <session-id-or-name> --pane <pane-id> --json
```

Use `--from-json` for structured create and update input. Keep multiline
context, evidence, links, and reports in the JSON file or stdin; do not put
external text into shell source. Re-read mutation results and inspect the
overview after associations or updates.

## Resume and refresh persisted context

Read `PANE_ORCHESTRATION_SESSION_ID` from the current environment whenever a
Session conversation starts or resumes. Pane exports this stable identity for
Session panels, including agent resume paths that do not receive the original
bootstrap input. Do not infer the Session from a terminal panel ID or from
conversation text.

When the variable is present, reload the saved record and then reconcile live
Pane, tab, branch, and evidence state:

```text
runpane sessions get --session "$PANE_ORCHESTRATION_SESSION_ID" --json
runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json
```

Run `get` to recover persisted intent and associations, and run `overview`
after a resume or mutation. If the variable is missing, use `runpane sessions
list --json` to resolve a Session explicitly; never guess an identity. If the
stable ID cannot be resolved, report the error before taking Session-specific
actions.

## Identity and overview

Each orchestration Session has a stable ID, a hidden detached Pane session for
its conversation, and one deterministic terminal panel for each supported
agent. The imported legacy Pane Chat record retains its legacy internal IDs,
resume IDs, and terminal buffers. New Session records must not reuse those
identities.

The overview joins persisted intent with fresh Pane, tab, branch, worktree,
agent, and available Git or pull request evidence. Working, idle, stopped,
exited, missing, and archived states describe activity or availability. They
do not prove completion. A completion report must carry inspectable evidence,
the report timestamp, and provenance; new activity makes an older report
stale.

## Session watcher

Use one durable, named watcher per Session, scoped to every associated Pane:

```text
runpane watch --as session-<session-id> --follow --pane <pane-id> \
  --kinds agent.ready,agent.blocked,agent.idle,panel.exited,pane.gone \
  --settle 180000 --blocked-settle 30000 --min-interval 600000 \
  --idle-backoff --json
```

Repeat `--pane` for each associated Pane. A discussion-only Session has no
follow watcher; never omit `--pane` to watch all Panes. After an associate or
detach mutation, refresh `sessions overview` and re-arm the same cursor with
the current Pane set. On restart, retain the `session-<session-id>` cursor and
capture a fresh output baseline before interpreting notifications. Return
blocked and decision findings to the Session conversation. Terminal idle or
exit remains activity evidence only.

## Skill cache contract

`main/src/services/skillCacheManager.ts` owns the cached upstream skills below
`<PANE_DIR>/skills/dcouple`, the source checkout at
`<PANE_DIR>/skills/.sources/dcouple-skills`, and the generated Pane Chat
assets at `<PANE_DIR>/skills/pane-chat/`. When Git synchronization is
unavailable, raw downloads provide the same required files.

The Session route depends on the cached `create-ticket`, `astra-ticket`,
`cold-read`, `explain-visually`, `pane-work-recap`, and
`pane-work-prioritizer` skills, plus `create-ticket`'s intent-handoff and
Socrates references, its agent definition, the Pane work-question guide, and
the existing review and QA support files. Clone and fallback paths must keep
these files available before the generated guide is written.

Every clone, pull, fallback download, and startup guide refresh reapplies the
Pane Sessions adapter to cached `runpane-orchestrator` files. The adapter
removes the upstream implementation lane and lifecycle block, preserves the
control-plane, inspection, configuration, dispatch, monitoring, feedback, and
evidence guidance, and states that every authorized implementation enters
`astra-ticket` after Session discussion and ticket work. It does not copy or
substitute the `astra-ticket` pipeline. Generated guides, project skills, and
cached guidance therefore share one route even after a later upstream refresh.
