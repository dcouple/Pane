name: "Base Plan Template v2 - Context-Rich with Validation Loops"
description: |

## Purpose

Template optimized for Codex to implement features with sufficient context and
self-validation loops.

## Core Principles

1. Context is king
2. Validation loops matter
3. Reuse existing patterns
4. Start simple, validate, then refine
5. Follow repository instructions and AGENTS guidance

---

## Goal

[What needs to be built]

## Why

- [Business or user value]
- [Integration with existing features]
- [Problems this solves]

## What

[User-visible behavior and technical requirements]

### Success Criteria

- [ ] [Concrete outcome]

## All Needed Context

### Documentation & References

```yaml
- url: [official documentation URL]
  why: [specific section to use]

- file: [path/to/example.ts]
  why: [pattern or gotcha to follow]
```

### Files Being Changed

```text
[Tree of every affected file marked with ← NEW, ← MODIFIED, or ← DELETED]
```

### Known Gotchas & Library Quirks

```text
- [Critical setup, version issue, or behavior]
```

## Implementation Blueprint

### Architecture Overview

[Top-down explanation of the approach]

### Key Pseudocode

```ts
// Only hot spots and tricky logic
```

### Data Models and Structure

```ts
// Shared types, validators, schema, request and response shapes
```

### Tasks

```yaml
Task 1:
MODIFY path/to/file.ts:
  - specific change

Task 2:
CREATE path/to/new-file.ts:
  - specific change
```

### Integration Points

```yaml
DATABASE:
  - schema: path
  - manual-step: command the user must run

ROUTES:
  - add to: path

FRONTEND:
  - api client: path
  - hook: path
  - component: path
```

## Validation Loop

```bash
npm run lint
npm run typecheck
```

## Final Validation Checklist

- [ ] Lint passes
- [ ] Typecheck passes
- [ ] Error cases handled
- [ ] Shared types exported when needed

## Anti-Patterns to Avoid

- Creating new patterns when existing ones work
- Skipping validation
- Hardcoding values that belong in config
- Creating files unnecessarily
