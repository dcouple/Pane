---
name: simple-plan
description: Produce a lightweight implementation plan for a direct user request before coding anything. Use when the change is likely straightforward and the user wants a quick gut-check rather than a full formal plan.
---

# Simple Plan

Give the user a short, concrete plan before implementation.

Workflow:
1. Investigate the current state enough to understand the change.
2. Explain the likely root cause or current behavior.
3. Propose the file-level changes and implementation order.
4. Include brief advice about risks or better alternatives when useful.
5. Stop and wait for approval before editing code.

Rules:
- Do not implement during the initial plan response.
- Keep the plan concise, but include concrete file references.
- If the task turns out to be broad or risky, recommend switching to `plan`.
