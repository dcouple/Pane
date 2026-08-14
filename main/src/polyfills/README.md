# Polyfills

This directory contains polyfills needed for the Pane application to run properly in different Node.js environments.

## ReadableStream Polyfill

The `readablestream.ts` file guarantees the Web Streams API (ReadableStream, WritableStream, TransformStream) is available as a global.

### Why is this needed?

The Web Streams API is not available in older Node.js versions and might not be globally available in some Electron contexts. Any dependency that reaches for the global rather than importing from `stream/web` needs it present before it loads.

This polyfill was originally added for the in-process `@anthropic-ai/claude-code` SDK. Pane no longer depends on that package — it spawns the user's own Claude Code CLI instead — so the polyfill is retained only to preserve the guarantee for the remaining dependency tree, not for any specific first-party consumer.

### How it works:

1. First, it checks if ReadableStream is already available globally
2. If not, it tries to use Node.js's built-in `stream/web` module (available in Node 16.5+)
3. If that fails, it falls back to the `web-streams-polyfill` package
4. The polyfill makes these APIs available globally

### Usage:

Loaded at the very beginning of the main process in `index.ts`, and in the headless daemon entry point `daemon/headless.ts`, before any other imports.
