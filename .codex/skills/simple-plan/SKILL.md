---
name: simple-plan
description: Quick gut-check before implementing when the user directly asks you to do something. Investigates, proposes a lightweight plan, and implements only after approval. Use this instead of `plan` when the change is straightforward.
argument-hint: "[what the user wants done]"
---

# Simple Plan

When the user directly asks for a change, investigate first and propose a short
plan before writing code.

## Plan Contents

### Current State
- root cause or current behavior
- concrete file references

### Proposed Changes
- what needs to change
- file references where relevant
- task list in implementation order

### Advice
- architectural or implementation guidance when useful

## Process

1. Investigate the codebase first
2. Present the plan to the user
3. Only implement after approval
4. After approval, keep one primary implementation authority by default
5. Keep the user's why, constraints, and non-goals explicit during implementation
6. After implementation, run `implementation-reviewer`
7. Prefer a fresh skeptical second review pass before declaring completion
8. If you have a separate Claude workflow available, it can be the parallel
   second-opinion lane, but Codex remains primary on this path

## Notes

- Keep the plan concise but concrete
- Include file references whenever possible
- If the task is broad or risky, recommend switching to `plan`
- Do not implement anything until the user approves
