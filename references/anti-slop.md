# Anti-slop policy

Pane vendors the 15 Oxlint rules from `dmmulroy/anti-slop` at commit
`cd064fe602b5915ff35e1e1c20836ca9bcb3729a` in
`tools/oxlint/anti-slop`. The snapshot is intentionally local so the rules run
deterministically and can be reviewed alongside the code they gate.

The severity split is based on a full-repository scan taken before the harness
was added. The scan covered `frontend`, `main`, `packages/runpane`, `shared`,
`tests`, `scripts`, all non-vendored `tools`, and every Playwright config. It
found 2,463 findings in 240 files. We block only rules with a zero baseline;
existing debt remains visible through `pnpm lint` without turning the initial
rollout into a cleanup project.

| Rule | Baseline findings/files | Lane | Reason |
| --- | ---: | --- | --- |
| `no-object-parameters` | 0/0 | blocking | Prevent new positional object bags without an explicit contract. |
| `no-reflect-apply` | 0/0 | blocking | Prefer direct, typed calls over reflective dispatch. |
| `no-unknown-type-aliases` | 0/0 | blocking | Prevent aliases that rename uncertainty instead of parsing it. |
| `no-widen-then-assert` | 0/0 | blocking | Prevent discarding known types and recovering them with assertions. |
| `no-reflect-get` | 4/1 | advisory | Existing test introspection needs a deliberate cleanup. |
| `no-chained-type-assertions` | 89/22 | advisory | Existing renderer and bridge casts need boundary-by-boundary review. |
| `no-conditional-empty-object-spread` | 34/16 | advisory | Existing option assembly uses conditional empty spreads. |
| `no-known-value-widening` | 142/65 | advisory | Broadly present across IPC and renderer state. |
| `no-module-mocking` | 31/13 | advisory | Main-process tests currently use module mocking extensively. |
| `no-runtime-typeof` | 417/94 | advisory | Runtime representation checks are common at legacy boundaries. |
| `no-shape-in-symbol-names` | 18/1 | advisory | Confined to RunPane contract tests. |
| `no-unknown-parameters` | 250/64 | advisory | Boundary parsing is not yet consistently factored. |
| `no-unknown-returns` | 37/21 | advisory | Some adapters still expose unparsed results. |
| `no-unsafe-dictionary-type` | 192/51 | advisory | Dictionary contracts need incremental tightening. |
| `require-safety-comment-for-type-assertion` | 1,249/177 | advisory | Enabling this immediately would obscure higher-signal findings. |

Run `pnpm lint:ox:extra` for a grouped summary or
`pnpm lint:ox:extra:details` for individual diagnostics. Advisory findings do
not fail lint. Configuration, execution, and report-parsing failures do fail so
an empty report cannot masquerade as success.

## Root cause policy

For agent-written Pane code, the most important class is uncertainty that leaks
past an I/O boundary and later becomes a widening or assertion. Ask: **is this
change fixing the root cause or a symptom?** The root fix parses IPC, daemon,
filesystem, process, or browser input once into a named domain type. A late
`unknown` alias, `typeof` ladder, dictionary, or assertion usually treats the
symptom. Advisory findings should guide that review even when they do not block.

Promote an advisory rule only in a focused cleanup issue that documents its
remaining findings, reaches a zero baseline for the full scope, and changes the
rule in both this table and the blocking configuration. Do not silence a class
globally to make a promotion appear clean.

The root development toolchain requires Node 22.18 or newer because Oxlint's
TypeScript plugin runs under the developer Node process. This does not change
Electron 41's bundled Node 24 runtime, and the published `runpane` wrapper keeps
its Node 18.17 runtime floor.
