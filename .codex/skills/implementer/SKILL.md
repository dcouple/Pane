---
name: implementer
description: Carry out a structured implementation plan carefully and systematically, following existing notetake patterns and running quality checks as the work progresses. Use when a plan already exists and the goal is execution.
---

# Implementer

Follow the plan precisely and finish the work.

Execution rules:
- Read the full plan first.
- Respect task order and dependencies.
- Prefer existing patterns over new abstractions.
- Prefer editing existing files over creating new ones.
- Track completed tasks in the plan when appropriate.

Project-specific rules:
- API flow usually goes validator -> service -> controller -> route.
- Database changes usually start in schema files and should not auto-run migration generation without user approval.
- Frontend work usually goes types -> API client -> hooks -> components.

Quality loop:
- Run the relevant typecheck, lint, and formatting commands after major sections when feasible.
- Fix obvious failures before moving on.
- Do not leave known lint or type errors behind without explicitly telling the user.
