# Code Review Criteria

Shared review criteria used by the PR review skill and the implementation-reviewer agent. This file has two layers: a project-agnostic core that transfers to any TypeScript/React codebase, and a per-repo section for Pane.

---

## 0. Discovery (Required First Step)

Before applying any criterion below, derive the project's actual floor from the repo itself. Read these sources in priority order and let them override anything generic in this file:

1. **AGENTS.md** (or CLAUDE.md) -- project conventions, forbidden patterns, tooling
2. **Lint configuration and blocking custom rules** -- the CI-enforced floor for new code
3. **tsconfig** -- path aliases, strictness flags, module resolution
4. **Package manifests** -- what frameworks, libraries, and toolchains actually exist

Where the derived floor conflicts with a generic criterion below, the repo's own rules win. State the override explicitly in the review rather than silently ignoring either source.

---

## 1. Bugs and Correctness (Must-Fix)

- Logic errors: incorrect conditionals, off-by-one, wrong comparison operators
- Null/undefined risks: missing optional chaining, unhandled nullable paths
- Async bugs: missing `await`, unhandled promise rejections, race conditions
- Error handling: missing `try/catch` on calls that can throw, unhandled error states
- State bugs: stale closures in hooks, missing dependency array entries

## 2. Security (Must-Fix)

- `dangerouslySetInnerHTML` without DOMPurify sanitization
- API keys, tokens, or credentials in frontend code
- User input rendered without sanitization
- Command injection or XSS vectors
- Auth/permission checks missing on new endpoints or IPC channels

## 3. React and Component Design (Should-Fix)

- Components under 200-300 lines; JSX under ~50 lines per component
- Single responsibility -- business logic separated from presentational rendering
- Props destructured at the function signature, explicitly typed
- Prop drilling through 3+ levels replaced with Context or state management
- Hooks never called inside loops, conditionals, or nested functions
- `useEffect` dependency arrays complete; cleanup functions present for subscriptions/timers
- `useCallback` on functions passed as props to child components
- `useMemo` only on genuinely expensive computations
- `useState` not used for values derivable from props or other state
- Error Boundaries at critical subtree boundaries
- Loading, error, and empty states all handled explicitly
- List rendering uses stable unique keys (never array index for dynamic lists)
- `React.lazy` + `Suspense` for code-split routes and heavy components

## 4. TypeScript (Should-Fix)

- No explicit `any` -- use a specific type or `unknown` with narrowing
- No `{}` as a type -- use `Record<string, unknown>` or a named interface
- Type assertions (`as X`) include a comment explaining why
- Double assertions (`as unknown as X`) are a blocking error, not just a smell
- `import type` used for type-only imports
- Interfaces preferred over type aliases for object shapes
- No `I` prefix on interface names

## 5. Conventions (Suggestion)

- File names match their default export
- `const` by default, `let` only when reassignment required, never `var`
- No `console.log` in committed code (except intentional server-side logging)
- No commented-out code blocks or dead code
- No unused imports or variables

---

## Pane

Project-specific criteria for this repo. These supplement the generic sections above.

**Quality gate:** `pnpm lint` and `pnpm typecheck` must pass. These are the CI-enforced commands.

**Anti-slop floor:** The 15 blocking Oxlint rules in `references/anti-slop.md` are the new-code floor. A review finding that recommends code violating any of these rules (e.g., chained type assertions, unsafe dictionary types, unguarded `unknown` parameters) is itself a defect.

**`any` is forbidden:** Per AGENTS.md, do not introduce explicit `any`. There is no comment-justification escape. ESLint enforces `@typescript-eslint/no-explicit-any` at error level.

**Knip:** Every Knip category is blocking. Unused exports, types, dependencies, and files are not advisory.

**Process boundaries:** Pane is Electron: main process, preload bridge, React renderer. Review IPC contract wiring -- new channels need registration in the preload bridge (`main/src/preload.ts`) and the daemon-owned channel classifier. Code that crosses a process boundary without going through the declared IPC surface is a must-fix.

**Boundary decoders:** I/O from IPC, daemon, filesystem, process, or browser input must be parsed at the boundary into a named domain type using `shared/validation/boundaryDecoder`. Late `unknown` aliases, representation ladders, or assertions that treat the symptom instead of parsing the input are a should-fix.
