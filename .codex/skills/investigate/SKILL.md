---
name: investigate
description: Investigate a bug or broken behavior through hypothesis-driven root cause analysis and report what is wrong without jumping straight to a fix. Use when something is failing or behaving unexpectedly.
---

# Investigate

Find the root cause before proposing a fix.

Rules:
- Do not make code changes unless the user explicitly approves diagnostic logging.
- Do not guess. Support every conclusion with evidence from code, logs, or commands.

Workflow:
1. Clarify expected behavior, observed behavior, and reproduction steps if missing.
2. Classify the bug type early: compile, logic, race, state, integration, environment, or UI.
3. Write 3-5 ranked hypotheses before reading deeply.
4. Test those hypotheses by tracing the relevant code and recent history.
5. Compare broken and working paths when possible.
6. When inspection is insufficient and a runtime surface exists, run a falsifiable experiment loop:
   - state one claim and its observable pass/fail signal;
   - use fresh isolated state and capture a baseline;
   - change one variable and drive the real CLI, socket, browser, desktop window, or TUI;
   - capture user-visible evidence plus logs and authoritative raw or persisted state;
   - classify the result as supported, refuted, or inconclusive;
   - revert failed experiments immediately and record the command, evidence, and verdict before the next loop.
7. If the cause is still unclear, propose targeted logging and explain exactly why.
8. When a candidate passes, freeze the exact known-good checkpoint, rerun from fresh state, probe adjacent behavior, and treat optional hardening as separate measured experiments.
9. Stop expanding once the acceptance criteria and adjacent probes pass; move broader architecture work to a follow-up.
10. Report the root cause, confidence level, affected files, likely introduction point, and what needs to change.

Red flags:
- proposing a fix before confirming the cause
- pursuing the same failed theory repeatedly
- stacking unmeasured experimental changes
- losing the known-good checkpoint before optional hardening
- analyzing code unrelated to the symptoms
