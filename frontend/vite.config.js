import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        port: parseInt(process.env.VITE_PORT || process.env.PORT || '4521', 10),
        strictPort: true
    },
    base: './',
    // Workaround for @xterm/xterm 6.0 double-minification bug (issue #103):
    // xterm ships pre-minified ESM; Vite's esbuild re-minify pass renames the
    // `ansi` parameter in InputHandler.requestMode but leaves a closure capture
    // pointing at the old name, throwing `ReferenceError: i is not defined`
    // when TUI apps (vim, opencode, etc.) trigger a DCS mode request.
    esbuild: {
        minifyIdentifiers: false
    },
    build: {
        // Ensure assets are copied and paths are relative
        assetsDir: 'assets',
        // Copy public files to dist
        copyPublicDir: true
    }
});
