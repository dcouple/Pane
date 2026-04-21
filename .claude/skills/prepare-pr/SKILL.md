---
name: prepare-pr
description: Commits changes grouped by done-plans, rebases main, builds API and webapp, then creates or updates a PR. Replaces the commit command. Use when you're ready to open or update a pull request.
argument-hint: "[optional: PR title or description]"
disable-model-invocation: true
---

# Prepare PR Agent

Commit, rebase, build, and open/update a pull request — all in one step.

## Step 1: Commit Changes Grouped by Done-Plans

### Gather info

1. List all done plans: `ls ./tmp/done-plans/`
2. Read each done-plan to understand what files and features it covers.
3. Run `git diff` and `git diff --cached` to see all staged and unstaged changes.

### Associate changes with plans

For each changed file:
1. Read the diff to understand what changed.
2. Match to a done-plan by topic, referenced files, or feature area.
3. Group into logical commit units — one commit per plan.

**Grouping rules**:
- Files related to the same done-plan go in one commit.
- Infrastructure/config supporting a plan goes with that plan's commit.
- `./tmp/` doc changes associated with a plan go in that plan's commit.
- Unrelated changes (no matching plan) get their own commit with a descriptive message.

### Create commits

For each group:
1. `git add <specific files>` — **never** `git add .` or `git add -A`
2. Review staged diff for secrets or credentials — warn the user if found.
3. Commit with message: `type: short description` (feat, fix, refactor, docs, chore). Under 72 chars. Imperative mood.

**Conventions**: Reference the plan name in the commit body if helpful. Keep subjects concise.

## Step 2: Rebase Main onto Current Branch

1. Fetch latest main: `git fetch origin main`
2. Rebase: `git rebase origin/main`
3. If conflicts occur:
   - Read the conflicting files and the incoming vs current changes.
   - If the resolution is **obvious** (e.g., non-overlapping additions, trivial formatting), resolve it yourself, `git add` the resolved files, and `git rebase --continue`.
   - If the resolution is **ambiguous** (e.g., both sides changed the same logic, semantic conflicts), show the user the conflict with context and ask them how to resolve it. Wait for their response before continuing.
4. After rebase completes, verify with `git log --oneline -10` that history looks correct.

## Step 2.5: Generate Production Migration SQL (If Schema Changed)

Check if `apps/api/src/shared/db/schema.ts` was modified in any commit on this branch (vs origin/main):

```bash
git diff origin/main...HEAD --name-only | grep schema.ts
```

If schema.ts was changed:
1. Run `npm run db:diff:prod` and capture the actual output SQL.
2. Wrap it in a transaction block (`BEGIN; ... COMMIT;`).
3. Include the **actual SQL** in the PR description under the **Schema Changes** section — not instructions to run a command.
4. Only include additive SQL (CREATE, ADD). If destructive SQL (DROP, ALTER type) appears, flag it for the user to review and confirm.

If schema.ts was NOT changed, omit the **Schema Changes** section from the PR template entirely.

## Step 3: Build and Fix Errors

Run both builds and fix any errors:

### Build webapp
```bash
npx nx build @doozy/webapp
```

### Build API
```bash
npx nx build @doozy/api
```

For each build:
1. If it **passes**, move on.
2. If it **fails**, read the error output carefully:
   - Fix type errors, missing imports, and build issues.
   - After fixing, re-run the failing build to confirm the fix.
   - Repeat until both builds pass.
3. If a fix requires non-trivial changes (architectural issues, missing dependencies), tell the user and ask how to proceed.

**Commit build fixes** as a separate commit: `fix: resolve build errors`

## Step 4: Create or Update Pull Request

1. Check for existing PR: `gh pr view --json number,title,body,url,state 2>/dev/null`

### If no PR exists — create one

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

### If PR already exists — update it

```bash
gh pr edit --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

### PR Description Template

Build the PR description from the done-plans. List work in **chronological order** based on plan dates (the `YYYY-MM-DD` prefix in filenames). When updating an existing PR, **append** new work to the existing description — never overwrite previous entries.

```markdown
## Summary
[1-3 sentence overview derived from done-plans and context.md]

## Work Completed
### 1. [Plan/Feature Name from earliest done-plan]
- Key changes and what they accomplish

### 2. [Plan/Feature Name from next done-plan]
- Key changes and what they accomplish

### 3. [Plan/Feature Name from latest done-plan]
- Key changes and what they accomplish

## Pre-Merge Testing
- [ ] [Short, specific thing to test based on the changes — e.g., "Verify new endpoint returns 200 with valid payload"]
- [ ] [Another key behavior to verify]
- [ ] [Edge case or integration point worth checking]

## Schema Changes
<!-- Only include this section if schema.ts was modified -->
- [ ] Migration SQL reviewed
- [ ] Migration applied to staging
- [ ] Migration applied to production

### Production Migration SQL
⚠️ Run this SQL against the production database BEFORE deploying:
```sql
BEGIN;
-- actual generated SQL from npm run db:diff:prod goes here
COMMIT;
```

## Build Verification
- [x] `npx nx build @doozy/webapp` passes
- [x] `npx nx build @doozy/api` passes
```

Use `$ARGUMENTS` as the PR title if provided, otherwise derive one from the done-plans.

## Step 5: Push to Remote

1. Push the branch: `git push -u origin <branch> --force-with-lease`
   - Use `--force-with-lease` since we rebased (safer than `--force`).
2. If `--force-with-lease` fails (remote has new commits not in local), tell the user and ask how to proceed.

## Step 6: Summary

Present the final result:

```
PR ready.

Commits:
- <commit summaries>

Build:
  webapp: PASS
  api: PASS

PR: <url>
Branch: <branch name> (rebased on main)

Done-plans included:
- <list of plan files>
```
