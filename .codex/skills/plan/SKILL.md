---
name: plan
description: Creates a reconciled implementation plan by combining a structured plan draft with a normalized intent brief and a PRP-style research dossier, then auto-reviews the final plan. Use when planning a new feature or significant change in Codex.
argument-hint: "[feature description or ticket reference]"
---

# Plan

Generate a complete plan for feature implementation with thorough research. The
plan must contain enough context for an AI agent to implement the feature in a
single pass.

Codex is the primary planner in this workflow. If you also have a separate
Claude workflow available, treat it as an optional second-opinion lane rather
than the source of truth.

## Step 1: Mandatory Repo Audit

Do not start drafting until you have verified the current repo shape for the
feature area.

### Verify These Facts In-Repo
- Primary entrypoint(s) and integration surfaces relevant to this feature
- Exact module names and singular/plural usage
- Validator/controller/service directory layout in the affected area
- Actual data-model/schema/type source of truth used by this codebase
- Existing user-facing or operator-facing surface(s) this feature extends
- Shared type/export hubs if cross-app types are needed
- Actual validation/build/typecheck workflow used by this repo

### Repo Audit Rules
- Do not assume any specific stack or layout. Discover the actual routing,
  validation, schema, frontend, and build patterns used by the current repo.
- Every existing file path cited in the final plan must have been opened in this
  session.
- Mark every path in the final plan as either `existing` or `new`.
- Never cite a line number unless it was verified in the current checkout.
- Never let template/example paths leak into the final plan.
- If the brief or user request conflicts with repo reality, add a `Known
  Mismatches / Assumptions` section that states the conflict and how the plan
  resolves it.

## Step 1b: Clarify Requirements (Only If Needed)

If, after the repo audit, the approach is genuinely unclear, ask the user 1-3
targeted design questions. Otherwise, proceed directly.

## Step 1c: External Research (Only If Needed)

- Library documentation
- Implementation examples
- Best practices and common pitfalls
- Prefer primary documentation when researching external behavior

## Step 2: Draft the Plan, Intent Artifact, and Research Dossier

Produce three artifacts from the same brief:

1. A provisional implementation plan using `./plan_base.md`
2. A normalized brief / intent artifact that preserves the why, locked
   decisions, non-goals, and success criteria in a compact downstream-friendly
   form
3. A supporting research dossier that behaves like a PRP: anchor-dense,
   selective, and focused on context transfer

The final output shown to the user is the reconciled plan, not the dossier.

### Step 2a: Draft the Provisional Plan

Use `./plan_base.md` in this skill directory as the template.

### Critical Context to Include

The AI agent only gets the context in the plan plus codebase access. Include:
- Intent / Why
- Verified Repo Truths
- Evidence with exact `file:line-line`
- Locked Decisions
- Documentation URLs when needed
- Code Examples from the codebase
- Gotchas
- Patterns to follow
- Known Mismatches / Assumptions
- Critical Codebase Anchors

### Plan Guidelines

- Required sections are: Summary, Intent / Why, Source Artifacts, Verified Repo
  Truths, Locked Decisions, Known Mismatches / Assumptions, Critical Codebase
  Anchors, Files Being Changed, Reconciliation Notes, Delta Design,
  Architecture Overview, Key Pseudocode, Tasks, Validation, and Open Questions.
- `Verified Repo Truths` contains facts only.
- Every fact needs `Fact`, `Evidence`, and `Implication`.
- Negative or absence-based claims also need `Search Evidence`.
- If it is not proven, it is not a fact.
- Every `MODIFY` path must already exist.
- Do not leak placeholder/example paths into the final plan.
- Keep repo facts separate from proposed changes.
- Mirror current codebase patterns rather than inventing approximate examples.
- Do not add compatibility layers unless the user explicitly asks.
- Do not add unit or integration tests by default.
- Use `[NEEDS CLARIFICATION]` markers instead of guessing.

### Step 2b: Create a Normalized Brief / Intent Artifact

Save a normalized brief / intent artifact at:
`./tmp/plan-artifacts/YYYY-MM-DD-description-brief.md`

This is a compact intent capsule for downstream implementation and review.
Include:
- Problem / outcome summary
- Who this matters for
- Locked decisions already made
- Non-goals / what must not be optimized away
- Success criteria
- Explicit user constraints

The final plan must record this path in `Source Artifacts`.

### Step 2c: Create a Research Dossier

Save a supporting dossier at:
`./tmp/plan-artifacts/YYYY-MM-DD-description-research-dossier.md`

The dossier should:
- behave like a PRP-style supporting artifact, not the final plan
- focus on critical codebase anchors, patterns to reuse, gotchas, external docs,
  and a suggested implementation shape
- use exact `file:line-line` references for repo claims
- include external docs only when they materially reduce risk
- avoid placeholder text and generic examples

## Step 3: Reconcile the Dossier into the Final Plan

Before saving the user-facing plan, compare the provisional plan against the
research dossier and reconcile them.

### Reconciliation Goals
- Import missing anchors from the dossier into the final plan
- Import missing docs, gotchas, and load-bearing constraints
- Preserve the brief's why, locked decisions, and non-goals as first-class
  constraints in the final plan
- Surface factual conflicts between the draft and dossier
- Remove duplicated or low-value sections
- Preserve a clean separation between verified facts, settled decisions, and
  proposed changes

### Reconciliation Rules
- The final plan is authoritative
- The brief / intent artifact is authoritative for why
- Do not paste the dossier wholesale into the plan
- If the plan and dossier disagree, re-check the repo before choosing a side
- If a simplification weakens the brief's intent, surface it rather than hide it
- Do not import unsupported dossier claims into `Verified Repo Truths`
- Keep only the highest-value anchors, patterns, docs, and gotchas
- Add concise `Reconciliation Notes`

### Pre-Save Reality Check

Before saving the plan, verify all of the following:
- Every `MODIFY` path exists
- No placeholder/example paths remain
- Every line anchor was checked in the current checkout
- Every `Verified Repo Truths` bullet includes `Fact`, `Evidence`, and
  `Implication`
- Every negative claim includes `Search Evidence`
- No future/proposal language appears inside `Verified Repo Truths`
- Entry points and integration points match the repo audit
- Code examples match current helper patterns
- The dossier has been compared against the provisional plan
- Any plan-vs-dossier conflicts were resolved or surfaced explicitly

## Step 4: Save the Final Plan and Supporting Artifacts

Save the final reconciled plan as:
`./tmp/ready-plans/YYYY-MM-DD-description.md`

Save the supporting research dossier as:
`./tmp/plan-artifacts/YYYY-MM-DD-description-research-dossier.md`

Save the normalized brief / intent artifact as:
`./tmp/plan-artifacts/YYYY-MM-DD-description-brief.md`

Only the reconciled plan belongs in `ready-plans`.

## Step 5: Review and Present

After saving the plan, run the review gates.

1. Run a skeptical review against the standards in `plan-reviewer`.
2. If you can run a fresh second review context, do it and compare results.
3. If you are operating alongside a separate Claude workflow, you may use that
   as the parallel second-opinion lane, but Codex remains the primary planner.
4. Split findings into:
   - Auto-fixable
   - Needs user input
5. Apply all auto-fixable changes silently.
6. Do not surface questions until all active review lanes are complete and their
   findings are merged.

### Present to the User

- Plan Summary: 3-5 bullets
- Questions for You: only genuine decisions or unresolved ambiguity
- Plan Link: `./tmp/ready-plans/[filename]`
- Optional links:
  - Brief / intent artifact
  - Research dossier
- End with: `Want to run another review pass, or is this ready to implement?`

If the user wants changes or another review pass, apply the changes and rerun a
fresh review.

Do not treat the plan as ready if factual blockers remain unresolved.

## Step 6: Return the Plan — Do Not Implement

Once the user confirms the plan is ready, tell them:

```text
Plan finalized! To implement, run:

/implement ./tmp/ready-plans/[filename]
```

Your job ends here. Do not start implementing the plan in the same step.

## Quality Checklist

- [ ] Supporting research dossier created
- [ ] Supporting brief / intent artifact created
- [ ] Existing file paths verified in-session
- [ ] No placeholder/example paths leaked from the template
- [ ] Plan includes `Intent / Why` and `Source Artifacts`
- [ ] Verified Repo Truths contains facts only
- [ ] Every verified fact has exact evidence
- [ ] Every negative claim has search evidence
- [ ] High-value anchors/docs/gotchas from the dossier were reconciled into the
      plan or intentionally dropped
- [ ] The brief's why, locked decisions, and non-goals survived reconciliation
- [ ] Validation gates are executable by AI
- [ ] References existing patterns
- [ ] Clear implementation path
- [ ] Error handling documented
