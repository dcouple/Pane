---
name: review
description: Performs a comprehensive PR code review. Reads the linked GitHub issue for context, runs quality checks, and reviews code for bugs, architecture, conventions, and frontend best practices. Posts structured findings as a PR review.
argument-hint: "[PR number or URL]"
disable-model-invocation: true
---

# PR Review Agent

Review a pull request for correctness, architecture, conventions, and frontend best practices.

## Step 1: Gather Context

### Read the PR
1. Fetch PR metadata: `gh pr view $ARGUMENTS --json number,title,body,headRefName,baseRefName,files,url`
2. Fetch the full diff: `gh pr diff $ARGUMENTS`
3. List changed files: `gh pr view $ARGUMENTS --json files --jq '.files[].path'`

### Read the linked issue
1. Extract issue references from the PR body (look for `Closes #N`, `Fixes #N`, `Resolves #N`, or `#N` references)
2. For each linked issue, read the full issue and comments:
   ```bash
   gh issue view <number> --json title,body,comments
   ```
3. Look for:
   - **Investigation reports** (between `<!-- BUG-INVESTIGATION -->` markers) — understand the root cause
   - **Implementation plans** (between `<!-- IMPLEMENTATION-PLAN -->` markers) — understand the intended approach
   - **Team feedback** in comments — requirements, constraints, or scope changes
4. If no issue is linked, note this in the review as an informational comment

### Understand the intent
Before reviewing any code, write down (internally):
- **What problem does this PR solve?** (from the issue)
- **What approach was planned?** (from the plan, if any)
- **What constraints or conventions apply?** (from CLAUDE.md)

## Step 2: Run Quality Gates

Run these checks and record results:

```bash
npm run typecheck
```

```bash
npm run lint
```

If either fails, include the specific errors in the review as **must-fix** items.

## Step 3: Review the Diff

Read the shared review criteria at `.claude/skills/review/CRITERIA.md`. This is the single source of truth for what to check.

For each changed file, evaluate against **all 7 sections** of the criteria. Organize findings by severity:

- **Sections 1-2 (Must-Fix):** Bugs, correctness, security. The PR should not merge without addressing these.
- **Sections 3-5 (Should-Fix):** Architecture, React patterns, TypeScript. Strong recommendation to fix.
- **Sections 6-7 (Suggestion):** Tailwind/shadcn, conventions. Nice-to-have, not blocking.

## Step 4: Check Completeness Against Issue

If an implementation plan exists in the issue:
- Verify every task in the plan has corresponding code changes
- Flag any planned work that appears missing or partially implemented
- Note any scope additions not in the original plan

## Step 5: Post the Review

Post findings as a **GitHub PR review** using `gh api`, not as an issue comment.

### Severity levels
- **Must-Fix** — Bugs, security issues, type/lint failures. The PR should not merge without addressing these.
- **Should-Fix** — Architecture violations, missing patterns, significant code quality issues. Strong recommendation to fix.
- **Suggestion** — Style, naming, minor improvements. Nice-to-have, not blocking.

### Review format

Post **inline comments** on specific lines where possible using the PR review API. Then post a summary review.

```bash
# Submit review with inline comments
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \
  --method POST \
  -f body="$(cat <<'EOF'
## PR Review

**Issue context:** #[issue number] — [one-line summary of what this PR should accomplish]

### Quality Gates
- Typecheck: PASS/FAIL
- Lint: PASS/FAIL

### Must-Fix ([count])
[Numbered list of blocking issues with file:line references]

### Should-Fix ([count])
[Numbered list of recommended fixes with file:line references]

### Suggestions ([count])
[Numbered list of non-blocking improvements]

### Completeness
[If linked to an issue with a plan: status of each planned task]
[If no plan: general assessment of whether the PR fully addresses the issue]

### Summary
[1-3 sentences: overall assessment and whether this is ready to merge after fixes]
EOF
)" \
  -f event="COMMENT" \
  --json url
```

Use `event: "REQUEST_CHANGES"` if there are must-fix items, `"APPROVE"` if clean, `"COMMENT"` otherwise.

### Inline comment format

For each specific issue, post an inline comment on the relevant line:

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \
  --method POST \
  -f event="COMMENT" \
  -f body="Summary" \
  --jq '.id'
```

Then add comments to the review using the review comments API. Group related comments into a single review submission.

## Rules

- **Read the issue first.** Never review code without understanding the intent.
- **Be specific.** Every finding must include a file path, line number, and concrete suggestion.
- **Prioritize correctly.** A real bug matters more than a style nit. Don't bury important findings in noise.
- **Don't nitpick what lint catches.** If ESLint or TypeScript will catch it, don't duplicate the feedback — just report the gate failure.
- **Acknowledge good work.** If the PR is well-structured or handles edge cases well, say so briefly.
- **Stay in scope.** Review the diff, not the entire codebase. Don't suggest refactoring unrelated code.
- Follow ALL conventions in CLAUDE.md
