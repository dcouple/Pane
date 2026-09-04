import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const source = resolve(root, 'frontend/dist');
const destination = resolve(root, 'mobile/www');
execFileSync('pnpm', ['--filter', 'frontend', 'build'], { cwd: root, stdio: 'inherit' });
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
// Capacitor always opens index.html. The native shell must use the bundled remote entrypoint.
await cp(resolve(source, 'remote.html'), resolve(destination, 'index.html'));
