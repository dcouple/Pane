---
name: create-plan
description: Creates a reconciled implementation plan by combining a structured plan draft with a normalized intent brief and a PRP-style research dossier, then auto-reviews the final plan. Use when planning a new feature or significant change.
argument-hint: "[feature description or ticket reference]"
allowed-tools: Read, Grep, Glob, WebFetch, WebSearch, Write, Task
---

# Create Plan Agent

## Feature: $ARGUMENTS

Generate a complete plan for feature implementation with thorough research. The plan must contain enough context for an AI agent to implement the feature in a single pass.

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

If, after the repo audit, the approach is **genuinely unclear**, ask the user
1-3 targeted design questions. Otherwise, proceed directly.

## Step 1c: External Research (Only If Needed)

- Library documentation (include specific URLs)
- Implementation examples
- Best practices and common pitfalls
- Prefer primary documentation when researching external behavior

## Step 2: Draft the Plan, Intent Artifact, and Research Dossier

Produce **three artifacts** from the same brief:

1. A **provisional implementation plan** using `./plan_base.md`
2. A **normalized brief / intent artifact** that preserves the why, locked
   decisions, non-goals, and success criteria in a compact downstream-friendly
   form
3. A **supporting research dossier** that behaves like a PRP: anchor-dense,
   selective, and focused on context transfer

The final output shown to the user is the **reconciled plan**, not the dossier.

### Step 2a: Draft the Provisional Plan

Using `./plan_base.md` (in this skill's directory) as template.

### Critical Context to Include

The AI agent only gets the context in the plan plus codebase access. Include:
- **Intent / Why**: the essence of the brief, including the user outcome,
  business/product reason, and what must not be optimized away
- **Verified Repo Truths**: checked facts only, grouped by area
- **Evidence**: exact `file:line-line` support for factual claims, plus search evidence for negative claims
- **Locked Decisions**: product/design choices already settled by the brief or user
- **Documentation**: URLs with specific sections
- **Code Examples**: Real snippets from codebase
- **Gotchas**: Library quirks, version issues
- **Patterns**: Existing approaches to follow
- **Known Mismatches / Assumptions**: brief-vs-repo conflicts, or explicit assumptions
- **Critical Codebase Anchors**: the highest-value repo anchors that an implementer should keep open while coding

### Implementation Blueprint

- Start with pseudocode showing approach
- Reference real files for patterns
- Include error handling strategy
- List tasks in implementation order

### Plan Guidelines

- **Required Sections** (never leave empty): Summary, Intent / Why, Source Artifacts, Verified Repo Truths, Locked Decisions, Known Mismatches / Assumptions, Critical Codebase Anchors, Files Being Changed (tree with ← NEW / ← MODIFIED markers), Reconciliation Notes, Delta Design, Architecture Overview (proportional to complexity), Key Pseudocode (hot spots and tricky logic only), Tasks (concrete file-level steps in order), Validation, and Open Questions.

- **Verified Repo Truths Are Facts Only**: This section may contain only facts checked in the current repo. No proposed files, pseudocode, or speculative guidance.
- **Evidence Contract**: Every bullet in `Verified Repo Truths` must use this shape:
  - `Fact: ...`
  - `Evidence: path:line-line`
  - `Implication: ...`
  - `Search Evidence: ...` is required for absence-based or negative claims such as "does not exist", "is never used", or "no X today".
- **If It Is Not Proven, It Is Not A Fact**: Unsupported claims move to `Delta Design`, `Known Mismatches / Assumptions`, or `Open Questions`.
- **Files Being Changed Must Be Realistic**: Every `MODIFY` path must already exist. Every `CREATE` path must fit the repo's current directory conventions.
- **No Placeholder Paths**: Final plans must not contain `<feature>`, `path/to/example.ts`, `existing-service.ts`, or any other illustrative template path that was not verified in the current repo.
- **Facts vs Proposals Must Be Separated**: Keep repo reality in `Verified Repo Truths`; keep proposed work in `Delta Design`, `Tasks`, and pseudocode.
- **No Proposal Language In Fact Sections**: `Verified Repo Truths` must not contain "we add", "we extend", "this plan", "for this feature", "will", or other future/proposed wording.
- **Code Examples Must Match Current Patterns**: If you include schema/validator/type/code snippets, mirror the helper and naming patterns already used in the repo rather than inventing approximate shapes.

- **No Backwards Compatibility**: Replace things completely. No shims, fallbacks, re-exports, or compatibility layers unless user explicitly requests it.
- **Deprecated Code**: Include a section at the end to remove code we no longer use as a result of this plan.
- **No Unit/Integration Tests**: Do not include test creation in the plan.
- **Flag Uncertainty**: When uncertain about a requirement, design decision, or implementation detail, do NOT guess or assume. Insert a `[NEEDS CLARIFICATION]` marker with a brief explanation of what's unclear and why it matters. These markers must be resolved with the user before the plan is finalized.

### Step 2b: Create a Normalized Brief / Intent Artifact

Create a normalized brief / intent artifact and save it as:
`./tmp/plan-artifacts/YYYY-MM-DD-description-brief.md`

This is not a prose dump of the original request. It is a compact intent
capsule for downstream implementation and review. Include:
- Problem / outcome summary
- Who this matters for
- Locked decisions already made
- Non-goals / what must not be optimized away
- Success criteria
- Any explicit user constraints

The final plan must record this path in its `Source Artifacts` section so
downstream skills can reload it.

### Step 2c: Spawn a Research Dossier Sub-Agent

Spawn one fresh `research-dossier-writer` sub-agent from the same brief.

Save the dossier as:
`./tmp/plan-artifacts/YYYY-MM-DD-description-research-dossier.md`

Prompt it to:
- create a PRP-style supporting artifact, not the final plan
- focus on critical codebase anchors, patterns to reuse, gotchas, external docs,
  and a suggested implementation shape
- use exact `file:line-line` references for repo claims
- keep external docs optional and only include them when they materially improve
  accuracy or reduce implementation risk
- avoid placeholder text and generic examples

Suggested sub-agent prompt:

```
Task tool:
  subagent_type: "research-dossier-writer"
  prompt: "Create a PRP-style research dossier for [feature]. Save it at
    [dossier path]. Focus on critical codebase anchors, patterns to reuse,
    gotchas/load-bearing decisions, useful external docs when needed, and a
    suggested implementation shape. Use exact file:line-line references for repo
    claims. Do not write the final implementation plan."
```

The dossier is a supporting artifact. It should be concise, evidence-backed, and
optimized for context transfer rather than section completeness.

## Step 3: Reconcile the Dossier into the Final Plan

Before saving the user-facing plan, compare the provisional plan against the
research dossier and reconcile them.

### Reconciliation Goals

- Import **missing anchors** from the dossier into the final plan
- Import **missing docs, gotchas, and load-bearing constraints**
- Preserve the brief's why, locked decisions, and non-goals as first-class
  constraints in the final plan
- Surface **factual conflicts** between the plan draft and the dossier
- Remove **duplicated or low-value sections** that add length without reducing
  implementation risk
- Preserve a clean separation between verified facts, settled decisions, and
  proposed changes

### Reconciliation Rules

- The **final plan is authoritative**; the dossier is supporting evidence
- The **brief / intent artifact is authoritative for why**; do not let plan
  convenience silently weaken it
- Do **not** paste the dossier wholesale into the plan
- If the plan and dossier disagree, re-check the repo before choosing a side
- If a plan simplification weakens the brief's intent, move that conflict into
  `Known Mismatches / Assumptions` or `Open Questions` instead of hiding it
- If a conflict cannot be resolved, move it to `Known Mismatches / Assumptions`
  or `Open Questions`
- Do not import unsupported dossier claims into `Verified Repo Truths`
- Preserve only the **highest-value** anchors, patterns, docs, and gotchas in
  the final plan
- Add a concise `Reconciliation Notes` section to the final plan documenting:
  - important anchors or docs imported from the dossier
  - any conflicts that were resolved
  - any dossier content intentionally dropped as duplicate or low-value

### Pre-Save Reality Check

Before saving the plan, verify all of the following:
- Every `MODIFY` path exists in the repo
- No placeholder/example paths remain
- Every line anchor was checked in the current checkout
- Every `Verified Repo Truths` bullet includes `Fact`, `Evidence`, and `Implication`
- Every negative or absence-based claim includes `Search Evidence`
- No future/proposal language appears inside `Verified Repo Truths`
- Entry points and integration points match the actual wiring discovered during the repo audit
- Code examples match current helper patterns exactly
- The research dossier has been compared against the provisional plan
- Any plan-vs-dossier factual conflicts were either resolved or surfaced explicitly
- Any imported anchors/docs/gotchas are concrete and evidence-backed
- The reviewer will be able to distinguish repo facts from proposed changes
- No unresolved factual blockers remain from the reviewer pass

Suggested placeholder/factuality grep before finalizing:
- `<feature>`
- `path/to/example`
- `Task N:`
- `\[actual `
- bullets in `Verified Repo Truths` missing `Evidence:`

## Step 4: Save the Final Plan and Supporting Artifacts

Save the **final reconciled plan** as:
`./tmp/ready-plans/YYYY-MM-DD-description.md`

Save the **supporting research dossier** as:
`./tmp/plan-artifacts/YYYY-MM-DD-description-research-dossier.md`

Save the **normalized brief / intent artifact** as:
`./tmp/plan-artifacts/YYYY-MM-DD-description-brief.md`

Only the reconciled plan belongs in `ready-plans`. Do not save the provisional
draft there.

## Step 5: Review and Present

After saving the plan, run the review gates. Do not skip this step.

1. **Claude review lane** — spawn a `plan-reviewer` sub-agent to review the
   plan:

```
Task tool:
  subagent_type: "plan-reviewer"
  prompt: "Review the plan at [plan path]. Supporting research dossier:
    [dossier path]. Supporting brief / intent artifact: [brief path]. Audit
    `Verified Repo Truths` first. Verify every factual claim against the
    current codebase, require exact evidence for each fact, require search
    evidence for negative claims, and flag any proposal language that leaked
    into fact sections. Then compare the final plan against the supporting
    brief: flag lost intent, weakened locked decisions, or dropped non-goals.
    Then compare it against the supporting dossier: flag missing anchors,
    missing gotchas/docs, factual conflicts, unsupported imported claims, and
    duplicated or low-value sections that survived reconciliation. Finally
    verify existing file paths, anchors, module names, integration points, and
    code examples. Produce a numbered list of specific, actionable
    recommendations covering repo-accuracy issues first, then brief-fidelity
    issues, then reconciliation issues, then gaps, simplification
    opportunities, correctness issues, and better alternatives."
```

2. **Codex review lane (if available).**

   If the Codex plugin is available in this session, launch the Codex audit in
   parallel with the Claude reviewer and **wait for both** before continuing.
   Do not treat the first result that returns as sufficient.

   Prefer a fresh, high-effort rescue run so Codex audits the actual saved plan
   against the current repo rather than free-associating:

```
/codex:rescue --wait --fresh --model gpt-5.4 --effort xhigh audit the plan at [plan path] against the current repository and the supporting brief at [brief path]. Focus on ghost paths, missing runtime wiring, auth/permission gaps, transaction boundaries, async/job registration, query params or routes with no consumer, brief-to-plan intent drift, and any task definitions that are likely to let an implementation stop short of the finish line. Return numbered findings with exact file references when possible and say explicitly whether the plan seems implementation-ready.
```

   If the Codex plugin is unavailable, run only the Claude review lane and
   treat it as the review gate.

3. **Triage and apply.** Split the combined review findings into two buckets:
   - **Auto-fixable** — Straightforward suggestions (missing details, small corrections, obvious improvements) that don't require a design decision. Apply these directly to the plan.
   - **Needs user input** — Questions about requirements, design trade-offs, ambiguous scope, or anything where multiple valid approaches exist.

   Apply all auto-fixable changes to the plan file silently.

   Do not ask the user questions from either lane before both active review
   lanes complete. Always wait, merge overlapping findings, and then present
   one combined set of user-facing questions or decisions.

4. **Present to the user:**

   **a) Plan Summary** — 3-5 bullet points covering what the plan does.

   **b) Questions for You** — Only combined review findings that need the user's input. For each one:
   - The reviewer's question or concern
   - **Context**: What the surrounding functionality does and why this matters. Reference specific files, patterns, or behaviors.

   If there are no questions (all feedback was auto-fixed), just say "Reviewer feedback was minor and has been incorporated."
   If factual blockers existed and were fixed, say so explicitly.
   If the Codex audit ran and was minor, say that explicitly too.

   **c) Plan Link:**
   ```
   Plan: ./tmp/ready-plans/[filename]
   ```

   **Optional supporting artifact links:**
   ```
   Brief / intent artifact: ./tmp/plan-artifacts/[brief-filename]
   Research dossier: ./tmp/plan-artifacts/[dossier-filename]
   ```

   **d) Next step prompt** — Always end with: "Want to run another review pass, or is this ready to implement?"

5. **If the user wants changes or another review pass:**
   - Apply any changes the user requested.
   - Spawn a **fresh plan-reviewer** and repeat from step 1.
   - If the Codex plugin is available, rerun a **fresh Codex audit** in parallel with the fresh Claude reviewer.
   - Each review lane must be fresh so it evaluates the current state without bias.

6. **If the user says it's ready** → proceed to Step 6.

**Do not treat the plan as ready if factual blockers remain unresolved.**

## Step 6: Return the Plan — DO NOT IMPLEMENT

Once the user confirms the plan is ready, tell them:

```
Plan finalized! To implement, run:

/implement ./tmp/ready-plans/[filename]

Explicit Claude executor:
/implement claude ./tmp/ready-plans/[filename]

Optional Codex executor (gpt-5.4, high):
/implement --codex ./tmp/ready-plans/[filename]
```

**CRITICAL: Your job ends here.** Do NOT start implementing the plan. Do NOT spawn implementer agents. Do NOT write or modify any application code. The `/create-plan` skill only produces a plan file — implementation is a separate step that the user will trigger themselves with `/implement`.

## Quality Checklist

- [ ] All necessary context included
- [ ] Supporting research dossier created
- [ ] Supporting brief / intent artifact created
- [ ] Existing file paths verified in-session
- [ ] No placeholder/example paths leaked from the template
- [ ] Plan includes `Intent / Why` and `Source Artifacts`
- [ ] Verified Repo Truths contains facts only
- [ ] Every verified fact has exact evidence
- [ ] Every negative claim has search evidence
- [ ] High-value anchors/docs/gotchas from the dossier were reconciled into the plan or intentionally dropped
- [ ] The brief's why, locked decisions, and non-goals survived reconciliation
- [ ] Factual conflicts between plan and dossier were resolved or surfaced explicitly
- [ ] No unsupported dossier claims were imported as facts
- [ ] Codex review lane completed or intentionally skipped because the plugin was unavailable
- [ ] Validation gates are executable by AI
- [ ] References existing patterns
- [ ] Clear implementation path
- [ ] Error handling documented
- [ ] Files Being Changed tree is filled in
- [ ] Architecture overview explains the big picture
- [ ] Key pseudocode covers hot spots
- [ ] Integration points and naming conventions match repo reality
- [ ] No unresolved [NEEDS CLARIFICATION] markers

Score the plan 1-10 (confidence for one-pass implementation success).

## Plan Lifecycle

- **Active plans**: `./tmp/ready-plans/`
- **Supporting research dossiers**: `./tmp/plan-artifacts/`
- **Completed plans**: `./tmp/done-plans/` (moved after successful implementation)
- **Cancelled plans**: `./tmp/cancelled-plans/` (moved if abandoned)
