---
name: commit
description: Selectively stages and commits only the changes related to the current session, skipping unrelated modifications.
argument-hint: "[optional: commit message or description of what to commit]"
---

# Commit Agent

Commit only the changes made in the current session to the local branch. Ignore
all other changes. Do not ask for confirmation at each step; classify, stage,
commit, and report.

## Step 1: Understand What Was Done

1. Check for plans in `./tmp/done-plans/` and `./tmp/ready-plans/`
2. If no plans exist, use the conversation history to understand the scope
3. If `$ARGUMENTS` is provided and is not already a `type: description` commit
   message, use it as extra classification context

## Step 2: Inspect All Changes

1. Run `git status`
2. Run `git diff` and `git diff --cached`
3. If there are no changes, stop and say so

## Step 3: Classify Changes

Include:
- files explicitly created or edited during this session
- files referenced by the implemented plan
- supporting changes clearly tied to the work
- relevant `./tmp/done-plans/` files and related context artifacts

Exclude:
- files not touched in this session
- pre-existing unrelated modifications
- unrelated changes from other agents or manual edits
- unrelated `./tmp/` files

When in doubt, include the file rather than leaving it out.

If zero files are clearly in scope, stop and say so.

## Step 4: Stage and Verify

1. Stage only specific in-scope files
2. Never use `git add .` or `git add -A`
3. Review the staged diff for secrets or credentials
4. If secrets are found, unstage them and ask the user how to proceed

## Step 5: Create the Commit

1. If `$ARGUMENTS` already matches `type: description`, use it verbatim
2. Otherwise derive a concise conventional commit message
3. Keep the subject under 72 characters
4. Add a short body when the commit covers multiple logical changes
5. Create the local commit and do not push

## Step 6: Report

Report:
- commit sha and subject
- files included
- files intentionally left uncommitted
- suggest `/prepare-pr` if appropriate
