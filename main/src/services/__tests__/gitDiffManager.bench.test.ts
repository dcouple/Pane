import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { hostname, platform, release } from 'os';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterAll, describe, expect, it } from 'vitest';
import { GitDiffManager } from '../gitDiffManager';
import { CommandRunner } from '../../utils/commandRunner';

const enabled = process.env.PANE_DIFF_BENCH === '1';
const directories: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(!enabled)('git diff manifest benchmark', () => {
  it('keeps 5,000-file manifest generation within budget', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pane-diff-bench-'));
    directories.push(cwd);
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Pane Bench');
    git(cwd, 'config', 'user.email', 'pane@example.test');
    for (let directory = 0; directory < 500; directory++) {
      const folder = join(cwd, `dir-${directory.toString().padStart(3, '0')}`);
      mkdirSync(folder);
      for (let file = 0; file < 10; file++) writeFileSync(join(folder, `file-${file}.txt`), 'before\n');
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'base');
    git(cwd, 'checkout', '-b', 'feature');
    for (let directory = 0; directory < 500; directory++) {
      for (let file = 0; file < 10; file++) writeFileSync(join(cwd, `dir-${directory.toString().padStart(3, '0')}`, `file-${file}.txt`), 'after\n');
    }
    const runner = new CommandRunner({ path: cwd });
    const manager = new GitDiffManager();
    const deps = { comparisonBase: async () => 'main' };
    let processCount = 0;
    const original = runner.execFile.bind(runner);
    runner.execFile = (...args) => { processCount += 1; return original(...args); };
    const run = async () => {
      const start = performance.now();
      const manifest = await manager.getDiffManifest(cwd, { kind: 'session' }, runner, deps);
      expect(manifest.files).toHaveLength(5000);
      return performance.now() - start;
    };
    const cold = await run();
    const timings: number[] = [];
    const beforeWarmProcesses = processCount;
    for (let index = 0; index < 20; index++) timings.push(await run());
    timings.sort((left, right) => left - right);
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const p95 = timings[Math.floor(timings.length * 0.95)];
    const gitProcessCount = (processCount - beforeWarmProcesses) / 20;
    process.stdout.write(`${JSON.stringify({ machine: hostname(), os: `${platform()} ${release()}`, git: git(cwd, '--version').trim(), coldMs: cold, p50Ms: p50, p95Ms: p95, gitProcessCount })}\n`);
    expect(gitProcessCount).toBe(6);
    expect(p95).toBeLessThanOrEqual(1000);
  }, 120_000);
});
