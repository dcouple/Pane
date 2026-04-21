# Medium Plan

## Feature file: $ARGUMENTS

Generate a complete PRP-style medium plan for general feature implementation
with thorough research. Ensure context is passed to the AI agent to enable
self-validation and iterative refinement. Read the feature file first to
understand what needs to be created, how the examples provided help, and any
other considerations.

The AI agent only gets the context you are appending to the plan and training
data. Assume the AI agent has access to the codebase and the same knowledge
cutoff as you, so it is important that your research findings are included or
referenced in the plan. The agent has websearch capabilities, so pass URLs to
documentation and examples.

This command is the middle lane between `/simple-plan` and the full
`/create-plan` workflow: optimize for fast, anchor-rich implementation guidance
rather than a fully reconciled and reviewed implementation contract.

## Research Process

1. **Codebase Analysis**
   - Search for similar features/patterns in the codebase
   - Identify files to reference in the plan
   - Note existing conventions to follow
   - Check test patterns for validation approach

2. **External Research**
   - Search for similar features/patterns online
   - Library documentation (include specific URLs)
   - Implementation examples (GitHub/StackOverflow/blogs)
   - Best practices and common pitfalls

3. **User Clarification** (if needed)
   - Specific patterns to mirror and where to find them?
   - Integration requirements and where to find them?

## Plan Generation

Using `./templates/prp_base.md` as template:

### Critical Context to Include and pass to the AI agent as part of the plan

- **Documentation**: URLs with specific sections
- **Code Examples**: Real snippets from codebase
- **Gotchas**: Library quirks, version issues
- **Patterns**: Existing approaches to follow

### Implementation Blueprint

- Start with pseudocode showing approach
- Reference real files for patterns
- Include error handling strategy
- List tasks to be completed in the order they should be completed

*** CRITICAL AFTER YOU ARE DONE RESEARCHING AND EXPLORING THE CODEBASE BEFORE
YOU START WRITING THE PLAN ***

*** ULTRATHINK ABOUT THE PLAN AND PLAN YOUR APPROACH THEN START WRITING THE PLAN

### Plan Guidelines

- **No Backwards Compatibility**: Never design plans with backwards
  compatibility in mind unless the user explicitly requests it. If something is
  being replaced or changed, replace it completely. Avoid shims, fallbacks,
  re-exports, or compatibility layers.
- **Deprecated Code**: Do not deprecate code that we are no longer using as the
  result of this plan. Instead, include a section at the end to remove it.
- **Unit & Integration Tests**: Do not include unit tests or integration tests

---

## Output

Save as: `./tmp/ready-plans/YYYY-MM-DD-description.md`
- Format: `YYYY-MM-DD-description.md` where:
  - YYYY-MM-DD is today's date
  - description is a brief kebab-case description
- Example:
  - `2026-04-20-heartbeat-system.md`

## Quality Checklist

- [ ] All necessary context included
- [ ] Validation gates are executable by AI
- [ ] References existing patterns
- [ ] Clear implementation path
- [ ] Error handling documented

Score the plan on a scale of 1-10 (confidence level to succeed in one-pass
implementation using claude code)

Remember: The goal is one-pass implementation success through comprehensive
context, but with a faster and lighter workflow than `/create-plan`.
