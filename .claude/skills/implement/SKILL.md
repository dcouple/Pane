---
name: implement
description: Executes an approved plan by breaking work into parallelizable chunks and spawning implementation sub-agents. Automatically reviews the result for completeness. Use after a plan is approved.
argument-hint: "[plan file path]"
disable-model-invocation: true
---

# Implementation Agent

## Plan to Execute: $ARGUMENTS

## Step 1: Load and Review Plan

- If a path is provided: Read from $ARGUMENTS
- If no path: Find the most recent plan in `./tmp/ready-plans/`

Review the plan to understand: implementation phases, task checklist, technical requirements, dependencies between tasks, and success criteria.

## Step 2: Identify Dangerous Commands

**BEFORE ANY IMPLEMENTATION**, scan the plan for commands that must NOT be run automatically:

- Environment variable changes
- Package installations that change `package.json`
- Any destructive operations

**Collect into a "Manual Steps" list** and present to the user before proceeding.

> **Note:** Schema/migration handling is done automatically in Step 5.5 after implementation and review — do NOT handle it here.

## Step 3: Break Plan into Chunks

1. **Identify Independent Units**: Group related tasks that can be completed together
2. **Respect Dependencies**: Schema before API, backend before frontend, types before implementations
3. **Chunk Size**: 2-5 related tasks with clear boundaries

```
Phase 1: Foundation (Sequential) → Schema, types
Phase 2: Core (Parallel) → Backend chunks, frontend chunks
Phase 3: Integration (Sequential) → Connect frontend to backend
```

**Late-phase tasks have higher skip risk** — flag any cross-cutting items sitting in late phases and consider promoting them.

## Step 4: Spawn Implementation Agents

Use `Task tool` with `subagent_type: "implementer"` for each chunk.

- **Parallel**: Spawn multiple agents simultaneously for independent chunks
- **Sequential**: Wait for dependent chunks to complete before next phase
- Each agent prompt must include: specific tasks, relevant context, file paths, success criteria — AND re-inject the plan's cross-cutting constraints (gotchas, mismatches, scope guards), since sub-agents don't inherit harness-level context and anything not repeated per-phase gets silently dropped.

## Step 5: Automatic Implementation Review

After all implementation agents complete, **automatically spawn an implementation-reviewer**:

```
Task tool:
  subagent_type: "implementation-reviewer"
  prompt: "Review the implementation against the plan at [path].
    Run npm run typecheck and npm run lint.
    Check every task in the plan was completed.
    Flag any gaps, missing integrations, or convention violations.
    Report completeness status for each plan task."
```

## Step 5.5: Generate Dev Migration SQL (If Schema Changed)

After the implementation-reviewer completes, check if `schema.ts` was modified:

```bash
git diff origin/main --name-only | grep schema.ts
```

If schema.ts was changed:

1. Run `npm run db:diff:dev` and capture the output.
2. Present TWO separate blocks to the user:

**Schema changes (migration SQL):**
```sql
BEGIN;
-- the generated migration SQL here
COMMIT;
```

**Apply migration to dev database:**
```bash
npm run db:migrate:dev
```
(Or whatever the actual command is — run it and show the result.)

3. Only include additive SQL (CREATE, ADD). If destructive SQL (DROP, ALTER type) appears, flag it and ask the user to confirm before proceeding.

If schema.ts was NOT changed, skip this step silently.

## Step 6: Move Plan to Done

Once all tasks pass review and the implementation is complete, move the plan file from `./tmp/ready-plans/` to `./tmp/done-plans/`:

```bash
mv ./tmp/ready-plans/<plan-file>.md ./tmp/done-plans/
```

Create `./tmp/done-plans/` if it doesn't exist. Only move the plan when all tasks are confirmed complete — if the reviewer found unresolved issues, wait until they are fixed.

## Step 7: Present Results

Present the implementation-reviewer's findings to the user:

```
Implementation complete.

Quality checks:
  typecheck: PASS/FAIL
  lint: PASS/FAIL

Completeness: X/Y tasks done
[List any MISSING or PARTIAL items]

Issues found: [count]
[Summarize key issues if any]

Manual steps remaining:
- [ ] [Dangerous commands from Step 2, if any]

Schema changes:
  [If Step 5.5 ran, show the migration SQL and apply command here]
  [If no schema changes, show "None"]

Plan moved to: ./tmp/done-plans/<plan-file>.md

Next steps:
- Fix any issues flagged above
- `/prepare-pr` — Commit, build, and open/update a PR
```

If the reviewer found issues, offer to fix them before the user commits. Only move the plan to `done-plans/` after all issues are resolved.
