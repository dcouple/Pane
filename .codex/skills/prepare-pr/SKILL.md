---
name: prepare-pr
description: Prepare a branch for review by committing scoped changes, rebasing on main, running builds, and creating or updating a pull request. Use when the user wants the branch ready for PR review.
---

# Prepare PR

This is a high-trust workflow. Surface any destructive or ambiguous step before proceeding.

Workflow:
1. Group current changes into logical commits, ideally by done-plan.
2. Create focused commits without staging unrelated work.
3. Fetch and rebase onto `origin/main`.
4. Resolve obvious conflicts directly. Ask the user about semantic conflicts.
5. Run the relevant build steps and fix straightforward failures.
6. Create or update the PR with a summary built from the plans and current diff.
7. Push with `--force-with-lease` only when rebase made it necessary.

Rules:
- Never use blanket staging.
- Treat secrets and credentials as stop conditions.
- Keep build-fix commits separate when they are distinct from the feature work.
- If GitHub CLI or network access is unavailable, report exactly where the flow stopped.
