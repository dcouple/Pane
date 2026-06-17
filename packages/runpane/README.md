# runpane

Thin npm installer and remote setup CLI for Pane.

The package does not include the Pane desktop runtime. It downloads the correct
Pane release artifact only when you run `runpane install` or `runpane update`.

## Usage

One-shot install:

```bash
npx --yes runpane@latest install client
npx --yes runpane@latest install daemon --label "My Server"
pnpm dlx runpane@latest install daemon --label "My Server"
```

Persistent install:

```bash
npm i -g runpane
runpane install daemon --label "My Server"

pnpm add -g runpane
runpane install daemon --label "My Server"
```

Compatible runners:

```bash
yarn dlx runpane@latest install daemon --label "My Server"
bunx runpane@latest install daemon --label "My Server"
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

npm package downloads use `source=npm` when requesting release artifacts from
`runpane.com/api/download`. If that route is unavailable, the CLI falls back to
matching GitHub release assets and prints a warning.

## Publishing

This package should be published through npm Trusted Publishing from GitHub
Actions. Token-based `NPM_TOKEN` publishing is a fallback for first package
reservation or manual publication only.
