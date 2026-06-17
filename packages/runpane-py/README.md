# runpane

Thin PyPI installer and remote setup CLI for Pane.

The package does not include the Pane desktop runtime. It downloads the correct
Pane release artifact only when you run `runpane install` or `runpane update`.

## Usage

One-shot execution:

```bash
pipx run runpane install daemon --label "My Server"
uvx runpane@latest install daemon --label "My Server"
```

Persistent install:

```bash
python -m pip install runpane
runpane install daemon --label "My Server"

pipx install runpane
runpane install daemon --label "My Server"
```

Module entrypoint:

```bash
python -m runpane install daemon --label "My Server"
```

## Commands

```bash
runpane install
runpane install client
runpane install daemon
runpane update
runpane version
runpane doctor
runpane --help
```

`runpane install daemon` installs Pane and then invokes the installed executable
with `--remote-setup`, preserving the `pane-remote://...` connection-code output.

## Attribution

PyPI package downloads use `source=pip` when requesting release artifacts from
`runpane.com/api/download`. If that route is unavailable, the CLI falls back to
matching GitHub release assets and prints a warning.

## Publishing

This package should be published through PyPI Trusted Publishing from GitHub
Actions. Token-based `PYPI_API_TOKEN` publishing is a fallback for first package
reservation or manual publication only.
