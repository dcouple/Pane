---
name: simple-plan
description: Quick gut-check before implementing when the user directly asks you to do something (e.g. "add X", "fix Y", "change Z"). Investigates, proposes a lightweight plan, and implements after approval. Use this instead of /create-plan when the user wants something done, not a formal plan.
argument-hint: "[what the user wants done]"
allowed-tools: Read, Grep, Glob, WebFetch
---

# Simple Plan

When the user directly asks me to make a change, I will first investigate and propose a plan before implementing anything. This ensures alignment before any code is written.

## My Plan Will Include

### Current State
- Root cause analysis explaining the current state
- File references and code snippets where relevant

### Proposed Changes
- Clear explanation of what needs to change
- File references and code snippets where necessary
- Task list of all work to be done

### My Advice
Feedback from a principal engineer perspective, providing overall architectural and implementation guidance.

## Process

1. Investigate the codebase first
2. Present the plan to the user
3. **Only when the user approves** will I proceed
4. After approval, prefer one primary `implementer` sub-agent to execute the whole plan rather than fragmenting it by default
5. Keep the user's stated why, constraints, and non-goals explicit during implementation rather than letting the task list silently replace them
6. After implementation, run the Claude `implementation-reviewer` and Codex review in parallel when the plugin is available, and wait for both before declaring completion
7. If the Codex plugin is unavailable, run the Claude `implementation-reviewer` alone before declaring completion

## Notes

- Instructions must be very clear with code snippets and file paths
- If implementation proceeds, keep one primary implementation authority unless the write scopes are clearly disjoint
- The final review must check both task completion and whether the implementation still satisfies the user's original intent
- I will not implement anything until the user approves

User Query: $ARGUMENTS
