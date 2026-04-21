name: "Base Medium Plan Template - Context-Rich and Fast" description: |

## Purpose

Template optimized for fast, context-rich plans that give an AI agent enough
implementation guidance to make forward progress without the overhead of a full
reconcile-and-review planning pipeline.

## Core Principles

1. **Context is King**: Include the documentation, examples, and caveats that actually matter
2. **Information Dense**: Use concrete repo anchors, not vague summaries
3. **Progressive Success**: Start simple, validate, then enhance
4. **Stay Practical**: Prefer the existing codebase shape over idealized design
5. **Global rules**: Follow all rules in CLAUDE.md

---

## Goal

[What needs to be built - be specific about the end state and desired behavior]

## Why

- [Business value and user impact]
- [Integration with existing features]
- [Problems this solves and for whom]

## What

[User-visible behavior and technical requirements]

### Success Criteria

- [ ] [Specific measurable outcomes]

## All Needed Context

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- url: [Official API docs URL]
  why: [Specific sections or methods you'll need]

- file: [path/to/example.ts]
  why: [Pattern to follow, gotchas to avoid]

- doc: [Library documentation URL]
  section: [Specific section about common pitfalls]
  critical: [Key insight that prevents common errors]
```

### Current Codebase Tree

```bash
```

### Desired Codebase Tree

```bash
```

### Known Gotchas & Library Quirks

```typescript
// CRITICAL: [Library name] requires [specific setup]
```

## Implementation Blueprint

### Data Models and Structure

```typescript
Examples:
 - Database schema definitions
 - Validators and type guards
 - TypeScript interfaces and shared types
 - API request/response types
```

### Tasks (in implementation order)

```yaml
Task 1:
MODIFY path/to/existing-file.ts:
  - FIND pattern: "export class ExistingClass"
  - INJECT new method following existing patterns
  - PRESERVE existing error handling

Task 2:
CREATE path/to/new-file.ts:
  - FOLLOW pattern from existing similar files
  - USE existing validation patterns
  - RETURN consistent response format

Task N:
...
```

### Per-Task Pseudocode (as needed)

```typescript
// Pseudocode with CRITICAL details - don't write entire code
```

### Integration Points

```yaml
DATABASE:
  - schema: "Add/modify schema definitions"
  - migration: "Generate and apply migration if applicable"

IPC/API:
  - handler: "Register IPC handler or API route"
  - types: "Add shared types for communication layer"

FRONTEND:
  - service: "Add frontend service/API client"
  - hook: "Create or update React hook"
  - component: "Create or update UI component"
```

## Validation Loop

```bash
# Run these FIRST - fix any errors before proceeding
npm run lint
npm run typecheck
# Expected: No errors. If errors, READ the error and fix.
```

## Final Validation Checklist

- [ ] No linting errors: `npm run lint`
- [ ] No type errors: `npm run typecheck`
- [ ] Error cases handled gracefully
- [ ] Shared types exported from shared modules if used across layers

## Anti-Patterns to Avoid

- Don't create new patterns when existing ones work
- Don't skip validation because "it should work"
- Don't mix async/await with callbacks
- Don't hardcode values that should be in `.env`
- Don't catch all errors - be specific with error types
- Don't create new files when editing existing ones works
- Don't forget framework-specific directives where required
