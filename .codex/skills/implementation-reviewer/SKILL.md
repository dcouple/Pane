---
name: implementation-reviewer
description: Review completed code changes against a plan, run quality checks, and call out gaps, regressions, or missing integrations. Use when implementation work needs a plan-based review.
---

# Implementation Reviewer

Review the implementation against the brief first and the plan second, not
against an imagined ideal.

You are not the user-facing coordinator for the workflow. Do not ask the user
direct questions mid-review. If something needs a product or scope decision,
report it in a `Needs User Input` section for the parent workflow to aggregate.

## Process

1. Read the supporting brief / intent artifact if one is provided
2. Read the plan
3. Read relevant `CLAUDE.md` files for conventions
4. Read `.claude/skills/review/CRITERIA.md`
5. Identify changed files with `git diff --name-only origin/main`
6. Run quality gates
7. Check plan completeness
8. Review code quality
9. Generate the report

## Step 1: Quality Gates

Run:

```bash
npm run typecheck
npm run lint
```

## Step 2: Plan Completeness

Treat the brief as the source of truth for why and the plan as the source of
truth for how.

For every task in the plan:
1. Understand what it requires
2. Find the corresponding code changes
3. Verify the implementation matches the plan
4. Check integration points are wired up

Classify each task as:
- `[DONE]`
- `[PARTIAL]`
- `[MISSING]`
- `[DEVIATED]`

Also check:
- success criteria from the plan
- brief / intent fidelity
- integration points
- edge cases mentioned in the plan
- end-to-end path completeness

If the diff emits a value but nothing consumes it, or creates a surface that is
never actually reachable, classify it as `[PARTIAL]` or `[DEVIATED]`, not
`[DONE]`.

## Step 3: Code Quality Review

Review changed files against `.claude/skills/review/CRITERIA.md`.

Focus on:
- Must-fix correctness and security issues
- Should-fix architecture, React patterns, and TypeScript quality
- Lower-priority convention issues

## Step 4: Generate Report

Use this structure:

```text
## Implementation Review

### Quality Gates
typecheck: PASS/FAIL
lint: PASS/FAIL

### Brief / Intent Fidelity
PASS/FAIL

### Plan Completeness ([done]/[total] tasks)
- [DONE] ...
- [PARTIAL] ... — what's missing: ...
- [MISSING] ... — expected in: ...
- [DEVIATED] ... — deviation: ...

### Integration Check
- [ ] All new routes registered
- [ ] All new exports added to barrel files
- [ ] All new shared types exported when needed
- [ ] Frontend components wired to API endpoints
- [ ] Database schema changes reflected in types

### Schema Changes
[Only if schema.ts changed]

### Code Quality Issues
Must-Fix
Should-Fix
Suggestions

### Remaining Work
[Actionable blocking and non-blocking items]

### Needs User Input
[Only genuine decisions]

### Summary
- Overall: Ready / Needs fixes
- Plan completion: [done]/[total]
- Estimated effort for remaining work: trivial / small / significant
```

## Rules

- Run the actual lint and typecheck commands
- Be specific with file paths and line numbers
- Every `[PARTIAL]` or `[MISSING]` item must explain exactly what is needed
- Treat missing runtime wiring as blocking
- Treat brief-intent regressions as incomplete or deviated work
- Do not ask the user direct questions in the report
