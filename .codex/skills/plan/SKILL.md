---
name: plan
description: Create a detailed implementation plan for a feature or significant change, grounded in codebase research and external documentation when needed. Use when the user wants a substantial change planned before coding.
---

# Plan

Create a context-rich implementation plan and stop after the plan is ready.

Workflow:
1. Clarify only genuinely ambiguous requirements.
2. Inspect the codebase for existing patterns, relevant files, and constraints.
3. Browse official documentation when the work depends on current external behavior.
4. Draft the plan using `./plan_base.md` in this skill directory.
5. Save it to `./tmp/ready-plans/YYYY-MM-DD-description.md`.
6. Perform one self-review using the standards from `plan-reviewer`.
7. Apply straightforward improvements silently.
8. Present the summary, any open questions, and the final plan path.

Plan requirements:
- Fill in Files Being Changed with a concrete tree.
- Include Architecture Overview and Key Pseudocode.
- Reference real codebase files and relevant documentation links.
- Call out gotchas, constraints, and integration points.
- Do not include backwards-compatibility shims unless requested.
- Do not add unit or integration tests to the plan by default.
- Use `[NEEDS CLARIFICATION]` markers instead of guessing.

Stop condition:
- Do not implement the plan in the same step unless the user explicitly changes scope.
