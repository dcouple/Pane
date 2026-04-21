# Code Review Criteria

Shared review criteria used by both the PR review skill and the implementation-reviewer agent. This is the single source of truth for what "good code" looks like in Doozy.

---

## 1. Bugs and Correctness (Must-Fix)

- Logic errors: incorrect conditionals, off-by-one, wrong comparison operators
- Null/undefined risks: missing optional chaining, unhandled nullable paths
- Async bugs: missing `await`, unhandled promise rejections, race conditions
- Error handling: missing `try/catch` on API calls, unhandled error states
- State bugs: stale closures in hooks, missing dependency array entries
- Data flow: mutations that don't invalidate the right query keys, optimistic updates without rollback

## 2. Security (Must-Fix)

- `dangerouslySetInnerHTML` without DOMPurify sanitization
- API keys, tokens, or credentials in frontend code
- User input rendered without sanitization
- `NEXT_PUBLIC_` prefix on server-only secrets
- SQL injection, command injection, or XSS vectors in API code
- Auth/permission checks missing on new API endpoints

## 3. Architecture and Patterns (Should-Fix)

**API (Express backend):**
- Three-layer architecture: Repository → Service → Controller
- Business logic must not live in controllers or route handlers
- New routes registered in `apps/api/src/routes/`
- Shared types exported from `@doozy/shared`

**Webapp (Next.js frontend):**
- Server Components by default; `"use client"` only when genuinely needed (hooks, event handlers, browser APIs)
- `"use client"` placed at the smallest viable boundary — not on layouts or large parent containers
- Thin pages — heavy logic lives in `_hooks/`, complex UI in `_components/`
- No Server Actions — all data flows through the Express API
- No direct database access from the webapp

**State management:**
- Server data managed exclusively via TanStack Query — never duplicated into Zustand
- Zustand used only for client/UI state (modals, theme, preferences)
- Mutations use `useMutation` with `onSuccess` invalidation, not manual store updates
- Components subscribe to Zustand via selectors, not full store objects

**Data fetching:**
- Independent requests use `Promise.all` / `Promise.allSettled`, not sequential `await`
- `React.cache()` used for deduplicating ORM/database calls in Server Components
- `<Suspense>` placed close to data-dependent components with meaningful skeleton fallbacks

## 4. React and Component Design (Should-Fix)

- Components under 200-300 lines; JSX under ~50 lines per component
- Single responsibility — business logic separated from presentational rendering
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

## 5. TypeScript (Should-Fix)

- No `any` without a justifying comment; prefer `unknown` for genuinely unknown types
- No `{}` as a type — use `Record<string, unknown>` or a named interface
- Type assertions (`as X`) include a comment explaining why
- Double assertions (`as unknown as X`) are a strong code smell — flag these
- `import type` used for type-only imports
- Interfaces preferred over type aliases for object shapes
- No `I` prefix on interface names

## 6. Tailwind CSS and shadcn/ui (Suggestion)

- Semantic token classes (`text-primary`, `bg-background`) — no hardcoded hex/rgb values
- Design tokens centralized in `globals.css` via `@theme` — not scattered in component files
- shadcn/ui base components in `components/ui/` not modified directly — use wrapper pattern
- `cn()` argument ordering deliberate: `cn("base-classes", className)` for overridable, `cn(className, "forced")` for enforced
- CVA used for component variants — not ad-hoc conditional class string concatenation
- Radix UI accessibility props (`role`, `aria-*`, `data-state`) preserved — not stripped
- `{...props}` spread present on wrapper components for prop forwarding

## 7. Conventions (Suggestion)

- All imports use `@/` aliases for local files, `@doozy/shared` for shared — no `../` relative imports
- Underscore-prefix locality: `_components/`, `_hooks/` for route-scoped files
- File names match their default export
- `const` by default, `let` only when reassignment required, never `var`
- No `console.log` in committed code (except intentional server-side logging)
- No commented-out code blocks or dead code
- No unused imports or variables
