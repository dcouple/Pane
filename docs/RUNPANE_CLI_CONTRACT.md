# Runpane CLI Contract

`runpane` is a thin installer and configurator for Pane. The npm and PyPI
packages expose the same command contract and download the real Pane release
artifact at command runtime.

The packages must not download, install, or configure Pane during package
installation. Work starts only when a user runs `runpane ...`.

## Maintainer Rules

Treat this file as the source of truth for both wrapper packages:

- Every command, flag, platform default, artifact-selection rule, and attribution
  rule change must be reflected here.
- The npm and PyPI wrappers must expose the same command behavior unless this
  contract explicitly documents a package-manager-specific difference.
- Root `README.md` should show the recommended user commands only. Package
  READMEs may include package-specific runners such as `yarn dlx`, `bunx`,
  `pipx`, or `uvx`.
- Release version bumps must keep root `package.json`, `packages/runpane`, and
  `packages/runpane-py` versions in sync. Run
  `pnpm run check:runpane-package-versions` before release.
- `pnpm run test:runpane-contract` must pass before changing wrapper command
  parsing, help output, platform defaults, or release asset selection.
- Token-based npm or PyPI publishing is a temporary fallback. Prefer trusted
  publishing once the package names are reserved and trusted publishers are
  configured.

## Compatibility Floors

The npm wrapper should run on Node.js `18.17.0` and newer. The root Electron app
may require a newer Node.js version for development and packaging.

The PyPI wrapper should run on Python `3.8` and newer. Keep runtime dependencies
out of the wrapper unless a compatibility test covers the new dependency.

## Package Manager Entrypoints

Canonical npm and Node commands:

```bash
npx --yes runpane@latest install client
npx --yes runpane@latest install daemon --label "My Server"
npm i -g runpane && runpane install daemon --label "My Server"
pnpm dlx runpane@latest install daemon --label "My Server"
pnpm add -g runpane && runpane install daemon --label "My Server"
yarn dlx runpane@latest install daemon --label "My Server"
bunx runpane@latest install daemon --label "My Server"
```

Canonical Python commands:

```bash
python -m pip install runpane
runpane install daemon --label "My Server"
pipx install runpane
pipx run runpane install daemon --label "My Server"
uvx runpane@latest install daemon --label "My Server"
python -m runpane install daemon --label "My Server"
```

Use `pnpm dlx` for one-shot pnpm execution and `pnpm add -g` for persistent
CLI installation. Do not document `pnpm install runpane` as the public CLI
install path.

## Commands

```bash
runpane install
runpane install client
runpane install daemon
runpane update
runpane version
runpane doctor
runpane help
runpane <command> --help
```

`runpane install` is an alias for `runpane install client`.

`runpane install client` downloads the selected Pane desktop artifact and
installs, opens, or launches it for the current platform.

`runpane install daemon` downloads or installs Pane, resolves a stable Pane
executable path, and spawns:

```bash
<pane executable> --remote-setup <forwarded remote setup args>
```

The wrapper must stream Pane stdout/stderr without reformatting because
`pane --remote-setup` prints the one-time `pane-remote://...` connection code.

`runpane update` uses the same release resolution and installer path as
`install client`.

`runpane version` prints the wrapper package version, the installed Pane
version when detectable, and the latest GitHub release version when reachable.

`runpane doctor` checks platform support, release metadata reachability,
download URL selection, installed Pane detection, and remote-daemon hints.

## Wrapper Flags

These flags are consumed by the wrapper:

```bash
--version <latest|vX.Y.Z>
--download-dir <path>
--pane-path <path>
--format <auto|appimage|deb|dmg|zip|exe>
--dry-run
--yes
--verbose
```

The top-level `runpane --version` form prints the wrapper version. The install
subcommand form `runpane install --version vX.Y.Z` selects a Pane release.

## Daemon Passthrough Flags

`runpane install daemon` forwards these flags to `pane --remote-setup`:

```bash
--label <name>
--prefer-tunnel <tailscale|ssh|manual|auto>
--channel <stable|nightly>
--base-url <url>
--pane-dir <path>
--listen-port <port>
--port <port>
--auto-listen-port
--interactive-tailscale-setup
--no-install-service
--no-tailscale-serve
--print-only
--repo-ref <ref>
```

Unknown daemon flags should be forwarded rather than dropped so newer Pane
versions can extend `--remote-setup` without requiring an immediate wrapper
release. Unknown flags for non-daemon commands should fail clearly.

## Download Attribution

The npm package uses `source=npm` for all npm-registry consumers, including
`npx`, `pnpm dlx`, `yarn dlx`, `bunx`, and global npm/pnpm installs.

The PyPI package uses `source=pip` for all Python consumers, including pip,
pipx, uvx, and `python -m runpane`.

Wrappers should prefer:

```text
https://runpane.com/api/download?platform=<platform>&arch=<arch>&format=<format>&version=<version>&channel=<channel>&source=<npm|pip>
```

If the website route cannot satisfy the download, wrappers may fall back to the
matching GitHub release asset and print a warning that website attribution may
be incomplete for that run.

## Publishing Credentials

Local implementation, build, and dry-run validation do not need npm or PyPI API
tokens. Release publishing should prefer npm Trusted Publishing and PyPI
Trusted Publishing from GitHub Actions.

Fallback `NPM_TOKEN` or `PYPI_API_TOKEN` credentials may be used for first
package reservation or manual publication only. They must be supplied through
local environment variables or GitHub Actions secrets, never committed, and
revoked or rotated after use.
