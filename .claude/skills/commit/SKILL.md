---
name: commit
description: Selectively stages and commits only the changes related to the current session, skipping unrelated modifications.
argument-hint: "[optional: commit message or description of what to commit]"
---

# Commit Agent

Commit only the changes you made in this session to the local branch. Ignore all other changes. **Do not ask for confirmation at any step — just classify, stage, commit, and report.**

## Step 1: Understand What Was Done

Gather context about what you implemented:
1. Check for plans in `./tmp/done-plans/` and `./tmp/ready-plans/` — if any exist, read them for file lists and feature descriptions.
2. If no plans exist, use the conversation history to understand what files you created or modified and why.
3. If `$ARGUMENTS` is provided and does NOT match the `type: description` commit message format, use it as additional context for what should be committed (it will be used for classification in Step 3, not as the commit message).

## Step 2: Inspect All Changes

1. Run `git status` to see all modified, added, and deleted files.
2. Run `git diff` (unstaged) and `git diff --cached` (staged) to see the actual changes. Treat both as a single pool of changes to classify.
3. If there are no changes at all, tell the user there is nothing to commit and stop.

## Step 3: Classify Changes

For each changed file (whether staged or unstaged), determine if it was changed **by you in this session** or not:

**Your changes** — include these:
- Files you explicitly created or edited during this conversation
- Files referenced in plans you implemented (done-plans or ready-plans)
- Supporting changes (imports, types, config) that are clearly tied to your work
- `./tmp/done-plans/` files and `./tmp/context.md` changes associated with your work

**Not your changes** — skip these entirely:
- Files you did not touch in this conversation
- Pre-existing modifications from before the session
- Changes from other agents or manual edits unrelated to your task
- Unrelated `./tmp/` files (research notes, other plans)

When in doubt, include the file rather than leaving it out.

If zero files are classified as yours, tell the user that no changes match this session's work and stop.

**Do not present the classification for confirmation. Proceed directly to staging.**

## Step 4: Stage and Verify

1. `git add <specific files>` — only the files you changed. **Never** `git add .` or `git add -A`.
2. Review the staged diff (`git diff --cached`) for secrets or credentials:
   - API keys, tokens, passwords
   - .env files or credential files
   - Private keys or certificates
3. If secrets are found, **warn the user**, unstage the offending files, and ask how to proceed. Do not commit files containing secrets.

## Step 5: Create the Commit

Do not ask for confirmation. Just create the commit.

1. Write a commit message:
   - If `$ARGUMENTS` matches the `type: description` format (e.g., `feat: add commit skill`), use it verbatim as the commit message.
   - Otherwise, derive a message from the work context.
   - Format: `type: short description` (feat, fix, refactor, docs, chore). Under 72 characters. Imperative mood.
   - Add a body with bullet points if the commit covers multiple logical changes.
2. Create the commit to the local branch. Do not push.

## Step 6: Report

Present the result. Only suggest `/commit` again if there are uncommitted files remaining.

```
Committed: <short sha> <commit message>

Files included:
  - <file list>

Files left uncommitted:
  - <file list, or "none">

Next steps:
  - `/prepare-pr` — Rebase, build, and open a PR
```
