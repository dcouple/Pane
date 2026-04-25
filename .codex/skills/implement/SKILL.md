---
name: implement
description: Executes an approved plan directly in Codex with one primary implementation stream by default, bounded sidecars only when write scopes are truly disjoint, and mandatory review gates for completeness and intent fidelity. Use after a plan is approved.
argument-hint: "[plan file path]"
---

# Implement

Execute the approved plan directly in this Codex session.

Codex is the primary implementation authority in this workflow. If you also
have a separate Claude workflow available, treat it as an optional parallel
second-opinion lane rather than the primary executor.

## Step 1: Load Plan and Supporting Artifacts

- If a path is provided, read that plan
- If no path is provided, use the most recent file in `./tmp/ready-plans/`
- If the plan includes `Source Artifacts`, read the brief / intent artifact and
  research dossier before coding

Treat sources of truth as:
- Brief / intent artifact: why this work exists and what must not be optimized away
- Plan: execution shape, task ordering, and file-level implementation details
- Dossier: supporting evidence, patterns, and anchors

If no separate brief exists, treat the plan's `Intent / Why`, `Locked
Decisions`, `Known Mismatches / Assumptions`, and success criteria as the
minimum intent source of truth.

## Step 2: Identify Dangerous Commands

Before implementing, scan the plan for commands that must not be run
automatically:
- environment variable changes
- package installations that change manifests
- destructive or irreversible commands

Collect them into a `Manual Steps` list and surface them before proceeding.

Schema / migration handling is done later after review. Do not handle it here.

## Step 3: Choose Execution Strategy

Default to one primary implementation stream.

Only split work when all of the following are true:
- write scopes are genuinely disjoint
- the integration contract is already clear in the plan
- parallelism will not hide missing last-mile wiring
- one primary owner still handles final integration and finish-line checks

Keep these with the primary stream unless there is an unusually clean reason
not to:
- schema and shared types
- routing / bootstrap / exports
- auth / permissions / tokens
- jobs / async orchestration / dispatch semantics
- final frontend-to-backend wiring

## Step 4: Implement

- Read the full plan before editing code
- Read the supporting brief before coding when available
- Prefer existing patterns over new abstractions
- Prefer editing existing files over creating new ones
- Update the plan progress as work completes
- Do not silently simplify, defer, or narrow scope
- If you must deviate, add a short `Plan Delta` note to the plan
- A task is not complete until the end-to-end runtime or user-facing path is
  actually wired and still preserves the intended outcome

Run these quality checks during the work when feasible:

```bash
npm run typecheck
npm run lint
```

## Step 5: Review Gates

After implementation, always run a review pass against the standards in
`implementation-reviewer`.

Minimum gate:
- one full implementation review pass

Preferred gate:
- a fresh skeptical second-opinion pass in a separate context

If you are operating alongside a separate Claude workflow, you may use that
second lane in parallel. If not, perform an additional adversarial Codex review
focused on:
- missing plan tasks
- brief-intent regressions
- runtime wiring
- auth / permission gaps
- transaction boundaries
- race conditions
- background-job registration
- dead query-param flows
- whether the implementation actually reached the finish line

Do not surface questions until all active review lanes are complete and their
findings are merged.

Split findings into:
- Auto-fixable
- Needs user input

Apply straightforward fixes directly, then rerun the review gate when needed.

## Step 5.5: Generate Dev Migration SQL (If Schema Changed)

After review gates are complete and auto-fixable issues are resolved, check if
`schema.ts` was modified:

```bash
git diff origin/main --name-only | grep schema.ts
```

If schema changed:
1. Run `npm run db:diff:dev`
2. Present the generated SQL in a transaction block
3. Present the command to apply the dev migration
4. If destructive SQL appears, stop and ask the user before proceeding

If schema did not change, skip this step silently.

## Step 6: Move Plan to Done

Once all tasks pass review, brief intent is preserved, and the implementation is
complete, move the plan from `./tmp/ready-plans/` to `./tmp/done-plans/`.

Only move the plan when all tasks are confirmed complete.

## Step 7: Present Results

Present the final result with:
- quality checks and their status
- intent fidelity status
- completeness against the plan
- issues found
- questions needing user input
- manual steps remaining
- schema changes, if any
- final plan path if it was moved

If the review found issues, offer to fix them before the user commits.
