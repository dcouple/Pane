---
name: implement
description: Execute an approved implementation plan directly in Codex, with manual-step detection, progress tracking, quality checks, and a final review against the plan. Use after a plan is approved.
---

# Implement

Execute a plan directly in the current Codex session.

Workflow:
1. Load the plan from the provided path. If no path is given, use the most recent file in `./tmp/ready-plans/`.
2. Read the whole plan before editing code.
3. Extract any manual-only steps and surface them before implementation:
   - database migrations such as `db:diff`
   - environment variable updates
   - package installs that change manifests
   - destructive or irreversible commands
4. Break the work into logical phases and track them with `update_plan`.
5. Implement the work directly. Follow existing patterns and update the plan checklist as work completes.
6. Run the quality checks the plan calls for, at minimum the relevant lint and typecheck commands when feasible.
7. Perform a final review against the original plan using the same standards as `implementation-reviewer`.
8. Move the plan from `./tmp/ready-plans/` to `./tmp/done-plans/` only after the implementation and review are complete.

Rules:
- Do not invent Claude-style subagents or rely on unsupported control syntax.
- Resolve straightforward review findings before finishing.
- If a review issue is ambiguous or high-risk, stop and ask the user.
- Keep unrelated repository changes out of scope.

Final handoff:
- Quality checks run and their status.
- Completeness against the plan.
- Remaining manual steps.
- Final plan path if it was moved.
