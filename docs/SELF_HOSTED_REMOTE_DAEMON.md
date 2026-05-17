# Self-Hosted Remote Daemon

This guide covers the current Phase 3 self-hosted workflow for running Pane on a user-managed machine and connecting to it from another Pane desktop client.

## What This Supports Today

- A headless Pane daemon host started with `pnpm daemon:headless`
- Daemon-owned commands and events over the remote HTTP/SSE transport
- Electron as the first remote client through the existing preload/renderer API
- Remote permission approval through the daemon-owned permission broker

This is intentionally not a hosted Pane Cloud workflow. It is for your own workstation, Mac mini, Linux box, or self-managed VM.

## Current Constraints

- The remote daemon listener only supports loopback hosts today: `127.0.0.1`, `::1`, or `localhost`
- Direct public or LAN binding is intentionally rejected
- Expose the daemon through a user-managed path such as:
  - SSH local port forwarding
  - Tailscale Serve / a trusted reverse proxy that forwards to loopback
  - Another secure tunnel that terminates on the host and proxies to `127.0.0.1:<port>`
- Local-only desktop actions stay local-only in remote mode:
  - `Open in IDE`
  - `Show in file manager`
  - native clipboard image fallback from the client machine

## Prerequisites

- Node `>=22.14.0`
- `pnpm >= 8`
- Pane dependencies installed with `pnpm install`
- A dedicated Pane data directory for the remote host, for example `~/.pane_remote`

## 1. Choose the Host Data Directory

Pick a host-side Pane directory and keep using it for both host configuration and the headless daemon.

Example:

```bash
export PANE_DIR="$HOME/.pane_remote"
mkdir -p "$PANE_DIR"
```

Pane stores the config and database under that directory. The headless daemon reads the same config file that the desktop app writes.

## 2. Configure the Remote Listener

Today the easiest way to configure the listener is from the Pane desktop app on the host machine, pointed at the same `PANE_DIR`.

Example launch:

```bash
PANE_DIR="$HOME/.pane_remote" pnpm dev
```

In `Settings > Self-Hosted Remote Daemon`:

1. Enable `Enable remote daemon listener`
2. Keep `Listen Host` on `127.0.0.1`
3. Keep or change `Listen Port` as needed, default `42137`
4. Leave `Require pairing / saved bearer tokens` enabled
5. Leave `Allow direct HTTP on loopback` enabled
6. Save host settings

This writes the listener config into `config.json` under your chosen `PANE_DIR`.

## 3. Create a Paired Connection

From the same settings section, create a paired connection:

1. Enter a label such as `Office Mac mini`
2. Enter the base URL the client will use after tunneling, for example `http://127.0.0.1:42137`
3. Click `Create Paired Profile`

Pane will:

- add a host-side allowed client record
- add a matching saved client profile
- show the generated bearer token once

Treat that token like a secret.

## 4. Start the Headless Daemon Host

Start the daemon against the same `PANE_DIR`:

```bash
PANE_DIR="$HOME/.pane_remote" pnpm daemon:headless
```

On success you should see a log line like:

```text
[Pane daemon] Headless host ready on tcp:127.0.0.1:42137
```

The local same-machine daemon socket will also be available for the desktop app on that host when relevant.

## 5. Expose the Loopback Listener Securely

### Option A: SSH tunnel

From the client machine:

```bash
ssh -N -L 42137:127.0.0.1:42137 user@your-host
```

Then use `http://127.0.0.1:42137` as the remote base URL in the client Pane app.

### Option B: Reverse proxy to loopback

Put a trusted reverse proxy on the host machine and forward traffic to `127.0.0.1:42137`.

Keep TLS and access control at the proxy layer. The current Pane daemon itself is not intended to be exposed directly on a public interface.

### Option C: Tailscale Serve or equivalent

Use a tunnel/proxy product that can reach the loopback listener on the host machine and expose it only to trusted devices.

## 6. Connect the Desktop Client

On the client machine, open Pane and go to `Settings > Self-Hosted Remote Daemon`.

If you already created the paired profile on that machine, click `Connect`.

If not, create or save a matching profile with:

- the same base URL the tunnel exposes locally on the client machine
- the token generated when the host-side pair was created

When connected successfully, the client mode should show:

- `Remote mode`
- `Status: connected via <profile label>`

## 7. Validate the Remote Flow

Recommended checks after connecting:

1. Verify projects and sessions load in the client
2. Open a terminal-backed session and confirm output streaming works
3. Send terminal input and verify the remote runtime receives it
4. Resize a terminal and confirm the remote terminal resizes
5. Open a file and confirm read/write works
6. Check git status and commit/diff flows
7. Run an `approve`-mode command and confirm the permission dialog appears on the client

## Permission Behavior

`approve` mode remains supported remotely.

The remote daemon owns pending permission state, and the desktop client receives:

- `permission:request`
- `permission:resolved`

Approving or denying on the client unblocks the remote daemon process.

## Reconnect / Disconnect Notes

- The Electron remote client will attempt to reconnect if the SSE event stream drops
- Returning to `Use Local Runtime` switches the client back to local mode without deleting the saved remote profile
- Deleting the active remote profile forces the client back to local mode

## Troubleshooting

### The headless daemon starts but remote connect fails

Check:

- the headless daemon is using the same `PANE_DIR` as the config you edited
- the tunnel/proxy is forwarding to the same loopback port as the host config
- the client profile base URL matches the client-side tunnel endpoint
- the bearer token matches the host-side paired client record

### I changed host settings but nothing happened

The headless daemon watches the config and will start or stop the remote transport based on the saved host config. If behavior still looks stale, restart the daemon once and verify the correct `PANE_DIR` is in use.

### Why can’t I bind to `0.0.0.0` or a LAN IP?

That is intentionally blocked in the current implementation. The present security model assumes loopback plus a user-managed secure exposure layer.

### Why are some actions disabled in remote mode?

Some actions operate on the local desktop client machine rather than the remote workspace. Pane currently disables or keeps local-only behavior for:

- opening a local IDE from the client
- revealing files in the client OS file manager
- the native clipboard-image fallback path

## Current Limitations

- No hosted relay, NAT traversal, or account-based multi-tenant auth
- No web/mobile client in this phase
- No direct non-loopback listener support
- Validation is strong on the main-process seams and maintained smoke suite, but it is not yet a full live remote end-to-end harness
