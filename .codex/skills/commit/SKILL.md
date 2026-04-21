---
name: commit
description: Selectively stage and commit only the changes related to the current session while leaving unrelated work untouched. Use when the user asks to make a focused local commit.
---

# Commit

Create one local commit containing only the work from the current session.

Workflow:
1. Gather context from the conversation and any plan files in `./tmp/done-plans/` or `./tmp/ready-plans/`.
2. Inspect `git status`, `git diff`, and `git diff --cached`.
3. Classify each changed file as in-scope or out-of-scope for this session.
4. Stage only in-scope files. Never use `git add .` or `git add -A`.
5. Review the staged diff for secrets or credentials.
6. Create a concise conventional commit message: `feat: ...`, `fix: ...`, `refactor: ...`, `docs: ...`, or `chore: ...`.

Rules:
- Ignore unrelated modifications.
- If no files clearly belong to this session, stop and say so.
- If secrets appear in staged changes, unstage them and ask the user how to proceed.
- Do not push unless the user explicitly asks.

Report:
- Commit sha and subject.
- Files included.
- Files intentionally left uncommitted.
