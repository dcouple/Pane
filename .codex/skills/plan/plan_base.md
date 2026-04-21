name: "Base Plan Template v2 - Context-Rich with Validation Loops"
description: |

## Purpose

Template optimized for AI agents to implement features with sufficient context
and self-validation capabilities to achieve working code through iterative
refinement.

## Core Principles

1. Context is king
2. Validation loops matter
3. Information density matters
4. Progressive success beats speculative overreach
5. Follow repository instructions and CLAUDE guidance

---

## Goal

[What needs to be built]

## Summary

[3-5 lines summarizing what ships, what areas change, and the overall approach]

## Intent / Why

- [Business value and user impact]
- [Integration with existing features]
- [Problems this solves and for whom]
- [What must remain true even if implementation details change]

## Source Artifacts

- Brief / intent artifact: [path to the normalized brief snapshot or canonical brief]
- Research dossier: [path to the supporting dossier]

## What

[User-visible behavior and technical requirements]

### Success Criteria

- [ ] [Specific measurable outcomes]

## Verified Repo Truths

Only include facts verified in the current repo state. This section must contain
existing files only. No proposed files, pseudocode, or speculative statements.

### Data / State

- Fact: [Current-state claim]
  Evidence: [path:line-line]
  Implication: [Why this matters for the plan]
  Search Evidence: [Required only for negative/absence claims]

### Entry Points / Integrations

- Fact: [Current-state claim]
  Evidence: [path:line-line]
  Implication: [Why this matters for the plan]
  Search Evidence: [Required only for negative/absence claims]

### Execution / Async Flow

- Fact: [Current-state claim]
  Evidence: [path:line-line]
  Implication: [Why this matters for the plan]
  Search Evidence: [Required only for negative/absence claims]

### Frontend / UI

- Fact: [Current-state claim]
  Evidence: [path:line-line]
  Implication: [Why this matters for the plan]
  Search Evidence: [Required only for negative/absence claims]

### Shared Types / Exports

- Fact: [Current-state claim]
  Evidence: [path:line-line]
  Implication: [Why this matters for the plan]
  Search Evidence: [Required only for negative/absence claims]

## Locked Decisions

- [Design/product decisions already settled by the brief or user]
- [Non-goals / guardrails that the implementation must not silently weaken]

## Known Mismatches / Assumptions

- Mismatch: [Repo-vs-brief mismatch, or explicit assumption]
  Repo Evidence: [path:line-line, plus search evidence if needed]
  Requirement Evidence: [brief text, user request, or external source]
  Planning Decision: [How the plan resolves the mismatch]
- [Write `None` if there are none]

## Critical Codebase Anchors

- Anchor: [existing repo path, subsystem, or flow]
  Evidence: [path:line-line]
  Reuse / Watch for: [specific pattern, invariant, or constraint]

## All Needed Context

### Documentation & References

- Repo reference: [existing repo path]
  Why: [pattern, behavior, or caveat to keep in mind]
- External doc: [official URL]
  Section: [specific section if relevant]
  Why: [what it clarifies]
  Critical insight: [key constraint or gotcha]

### Files Being Changed

```
[Tree of all affected files, each marked with ← NEW, ← MODIFIED, or ← DELETED]
[Annotate each entry as existing or new when useful for clarity]
```

### Known Gotchas & Library Quirks

Write concrete gotchas only. If there are none, write `None`.

- [Concrete repo, library, runtime, or product gotcha and why it matters]

## Reconciliation Notes

- Added from dossier: [anchor, doc, or gotcha imported into the final plan]
- Conflict resolved: [plan-vs-dossier disagreement and repo-verified resolution]
- Intentionally dropped: [duplicate or low-value material removed from the final plan]

## Delta Design

### Data / State Changes

Existing:
- [What exists today]

Change:
- [What will change]

Why:
- [Why this shape is appropriate]

Risks:
- [Key implementation or migration risks]

### Entry Point / Integration Flow

Existing:
- [What exists today]

Change:
- [What will change]

Why:
- [Why this shape is appropriate]

Risks:
- [Key routing, orchestration, or validation risks]

### Execution / Control Flow

Existing:
- [What exists today]

Change:
- [What will change]

Why:
- [Why this shape is appropriate]

Risks:
- [Key scheduling / orchestration / concurrency risks]

### User-Facing / Operator-Facing Surface

Existing:
- [What exists today]

Change:
- [What will change]

Why:
- [Why this shape is appropriate]

Risks:
- [Key UX / state / auth risks]

### External / Operational Surface

Existing:
- [What exists today]

Change:
- [What will change]

Why:
- [Why this shape is appropriate]

Risks:
- [Key observability / operational risks]

## Implementation Blueprint

### Architecture Overview

[High-level explanation of the approach]

### Key Pseudocode

```typescript
// Pseudocode with critical details only
```

### Data Models and Structure

```typescript
Examples:
 - Data model / schema definitions from the repo's actual source of truth
 - Validation schemas / request contracts from the project's actual validation layer
 - Shared interfaces / types / export hubs used by this codebase
 - API request/response types or other integration contracts
```

### Tasks (in implementation order)

Task [number]:
Goal:
- [What this task unlocks]
Files:
- MODIFY [existing repo path]
- CREATE [new repo path]
Pattern to copy:
- [existing repo path]
Gotchas:
- [Critical caveat]
Definition of done:
- [Observable completion state]

### Integration Points

- Data / schema source of truth: [actual file or directory discovered during the repo audit]
- Entry points to extend: [actual route, command, worker, event, or bootstrap entrypoint]
- Validation layer: [actual library, middleware, or contract pattern used by this repo]
- Domain / service layer: [actual file or directory pattern used by this codebase]
- User-facing / operator-facing surface: [actual page, view, command, or workflow]
- Shared types / export hubs: [actual shared locations if cross-boundary types are needed]
- External / operational hooks: [actual cron, queue, webhook, env, or admin surface if applicable]

## Validation

```bash
npm run lint
npm run typecheck
```

### Factuality Checks

- `Verified Repo Truths` uses `Fact / Evidence / Implication` for every bullet
- Every negative claim also includes `Search Evidence`
- No proposal/future language appears in `Verified Repo Truths`
- No placeholder/template strings remain in the final plan
- Every `MODIFY` path exists

### Manual Checks

- Scenario: [Manual scenario]
  Expected: [Expected user-visible or operational result]

## Open Questions

- [Write `None` if there are none]

## Final Validation Checklist

- [ ] No linting errors: `npm run lint`
- [ ] No type errors: `npm run typecheck`
- [ ] Error cases handled gracefully
- [ ] Shared types / contracts are exported from the codebase's actual shared hubs if needed
- [ ] Verified Repo Truths contains only checked facts
- [ ] Every verified fact includes exact evidence
- [ ] Every negative claim includes search evidence
- [ ] No proposal language appears in `Verified Repo Truths`
- [ ] Every `MODIFY` path exists in the repo
- [ ] No template/example placeholders remain
- [ ] High-value anchors/docs/gotchas from the supporting dossier were reconciled into the final plan or intentionally dropped
- [ ] Any plan-vs-dossier factual conflicts were resolved or surfaced explicitly
- [ ] Entry points and integration points match the current repo structure discovered during the audit
- [ ] No unresolved factual blockers remain from review

## Deprecated / Removed Code

- [Code paths to delete or simplify as part of the change]

## Anti-Patterns to Avoid

- Don't mix verified repo facts with proposed changes
- Don't cite unverified file paths or line anchors
- Don't make negative claims without search evidence
- Don't let template placeholders survive into the final plan
- Don't paste the supporting dossier wholesale into the final plan
- Don't silently choose between conflicting plan and dossier claims without re-checking the repo
- Don't invent approximate code patterns when the repo already has exact ones
- Don't create new patterns when existing ones work
- Don't skip validation because "it should work"
