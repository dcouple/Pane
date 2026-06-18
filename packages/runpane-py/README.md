# runpane

Install or configure Pane from PyPI.

The package does not include the Pane desktop runtime. It downloads the correct
Pane release artifact only when you run `runpane install` or `runpane update`.

## Quick Start

Run the guided setup:

```bash
pipx run runpane
```

Persistent install:

```bash
python -m pip install runpane
python -m runpane setup
```

The wizard can install Pane on this machine, configure this machine as a remote
host, update Pane, or run diagnostics.

## Advanced

### Explicit Commands

```bash
pipx run runpane setup
pipx run runpane install client
pipx run runpane install daemon --label "My Server"
pipx run runpane update
pipx run runpane doctor
```

`runpane install daemon` installs Pane and then invokes the installed executable
with `--remote-setup`, preserving the `pane-remote://...` connection-code output.

### Python Runners

One-shot execution:

```bash
uvx runpane@latest
```

Persistent install:

```bash
python -m pip install runpane
python -m runpane setup

pipx install runpane
runpane setup
```

### Commands

```bash
runpane
runpane setup
runpane install
runpane install client
runpane install daemon
runpane update
runpane version
runpane doctor
runpane --help
```

### Common Options

```bash
--version <latest|vX.Y.Z>
--format <auto|appimage|deb|dmg|zip|exe>
--download-dir <path>
--pane-path <path>
--dry-run
--verbose
```

Daemon setup also forwards Pane remote-host options:

```bash
--label <name>
--prefer-tunnel <tailscale|ssh|manual|auto>
--print-only
```

## Attribution

PyPI package downloads use `source=pip` when requesting release artifacts from
`runpane.com/api/download`. If that route is unavailable, the CLI falls back to
matching GitHub release assets and prints a warning.

The wrapper also sends best-effort lifecycle telemetry with a persisted
anonymous `install_id`. Count distinct wrapper users with
`count(DISTINCT properties.install_id)` on `runpane_wrapper_*` events. Set
`RUNPANE_TELEMETRY_DISABLED=1` to disable wrapper telemetry.

## Maintenance Notes

Keep the npm and PyPI clients in sync with each Pane release. When changing
shared installer behavior:

- If release asset names or platforms change, update both npm and PyPI wrapper
  artifact matching.
- If `runpane` CLI behavior changes, update both clients and the shared smoke
  tests.
- If the website `/api/download` contract changes, verify npm and PyPI fallback
  behavior.
- If daemon setup flags change, update docs, README files, and wrapper tests
  together.
- Keep the CI wrapper matrix green: Linux, macOS, Windows, Node 18/22, and
  Python 3.8/3.13.

## Publishing

This package should be published through PyPI Trusted Publishing from GitHub
Actions. Token-based `PYPI_API_TOKEN` publishing is a fallback for first package
reservation or manual publication only.
