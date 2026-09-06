import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../../utils/commandRunner';
import { PathResolver } from '../../utils/pathResolver';
import type { SessionManager } from '../sessionManager';
import { GitFileWatcher } from '../gitFileWatcher';
import { SpotlightManager } from '../spotlightManager';

const directories: string[] = [];
const managers: SpotlightManager[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pane-spotlight-'));
  directories.push(root);
  vi.stubEnv('PANE_DIR', join(root, 'data'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Pane Test');
  git(root, 'config', 'user.email', 'pane@example.test');
  writeFileSync(join(root, 'tracked.txt'), 'original\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'initial');
  const worktree = join(root, 'worktree');
  git(root, 'worktree', 'add', '-b', 'feature', worktree);
  writeFileSync(join(worktree, 'tracked.txt'), 'spotlight\n');
  const project = { id: 1, path: root };
  const runner = new CommandRunner(project);
  const collaborators = {
    getDbSession: () => ({ id: 's1', project_id: 1, worktree_path: worktree }),
    getProjectForSession: () => project,
    getProjectContextByProjectId: () => ({ commandRunner: runner, pathResolver: new PathResolver(project) }),
  };
  // SAFETY: Spotlight uses only these three SessionManager lookups; real Git
  // supplies the state transitions under test, without a database fixture.
  const sessionManager = collaborators as SessionManager;
  const manager = new SpotlightManager(sessionManager, undefined, () => null);
  managers.push(manager);
  // Watcher startup/cancellation has its own coverage; no file events should
  // race the explicit lifecycle operations in these real-repository tests.
  vi.spyOn(GitFileWatcher.prototype, 'startWatching').mockResolvedValue();
  return { root, worktree, runner, manager };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.disableAll();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Spotlight asynchronous lifecycle', () => {
  it('syncs initial contents and uses the same restore path for disable and shutdown', async () => {
    const { root, manager } = harness();
    await manager.enable('s1');
    expect(git(root, 'branch', '--show-current')).toBe('');
    expect(git(root, 'show', 'HEAD:tracked.txt')).toBe('spotlight');
    expect(manager.isSpotlightActive('s1')).toBe(true);

    await manager.disable('s1');
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(git(root, 'show', 'HEAD:tracked.txt')).toBe('original');
    await manager.enable('s1');
    await manager.disableAll();
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(manager.getActiveSpotlight(1)).toBeNull();
  });

  it('serializes disable behind an in-flight initial sync so late Git cannot undo restoration', async () => {
    const { root, runner, manager } = harness();
    const execute = runner.execFile.bind(runner);
    let release = (): void => { throw new Error('Sync not started'); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    let notifyStarted = (): void => { throw new Error('Listener not installed'); };
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    vi.spyOn(runner, 'execFile').mockImplementation(async (file, args, cwd, options) => {
      if (args[0] === 'stash') {
        notifyStarted();
        await gate;
      }
      return execute(file, args, cwd, options);
    });

    const enabling = manager.enable('s1');
    await started;
    const disabling = manager.disable('s1');
    release();
    await Promise.all([enabling, disabling]);

    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(manager.isSpotlightActive('s1')).toBe(false);
  });

  it('keeps one spotlight per project when enables arrive concurrently', async () => {
    const { manager } = harness();
    const outcomes = await Promise.allSettled([manager.enable('s1'), manager.enable('s1')]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(manager.getActiveSpotlight(1)).toEqual({ sessionId: 's1', active: true });
  });

  it('reconciles another file event received while a sync is in flight', async () => {
    const { root, worktree, runner, manager } = harness();
    await manager.enable('s1');
    const watcher = vi.mocked(GitFileWatcher.prototype.startWatching).mock.instances[0];
    const execute = runner.execFile.bind(runner);
    let release = (): void => { throw new Error('Sync not started'); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    let notifyStarted = (): void => { throw new Error('Listener not installed'); };
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let delayed = false;
    vi.spyOn(runner, 'execFile').mockImplementation(async (file, args, cwd, options) => {
      const result = await execute(file, args, cwd, options);
      if (args[0] === 'stash' && !delayed) {
        delayed = true;
        notifyStarted();
        await gate;
      }
      return result;
    });

    writeFileSync(join(worktree, 'tracked.txt'), 'first update\n');
    watcher.emit('needs-refresh', 's1');
    await started;
    writeFileSync(join(worktree, 'tracked.txt'), 'latest update\n');
    watcher.emit('needs-refresh', 's1');
    release();

    await vi.waitFor(() => {
      expect(git(root, 'show', 'HEAD:tracked.txt')).toBe('latest update');
    }, { timeout: 5000 });
  });
});
