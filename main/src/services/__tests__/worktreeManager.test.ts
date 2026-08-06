import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../utils/commandRunner';
import { WorktreeManager } from '../worktreeManager';

function commandRunner(
  execAsync: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>,
): CommandRunner {
  return { execAsync: vi.fn(execAsync) } as CommandRunner;
}

describe('WorktreeManager.getSessionComparisonBranch', () => {
  it('uses the recorded fork commit before a remote default branch for a legacy worktree', async () => {
    const runner = commandRunner(async command => {
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const comparisonBranch = await manager.getSessionComparisonBranch(
      {
        baseBranch: 'HEAD',
        baseCommit: 'pane-start-commit',
        worktreePath: '/repo/worktrees/pane',
      },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(comparisonBranch).toBe('pane-start-commit');
    expect(runner.execAsync).not.toHaveBeenCalled();
  });

  it('uses the remote default branch for a legacy worktree session', async () => {
    const runner = commandRunner(async command => {
      if (command.includes('symbolic-ref')) {
        return { stdout: 'origin/main\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const comparisonBranch = await manager.getSessionComparisonBranch(
      { baseBranch: 'HEAD', worktreePath: '/repo/worktrees/pane' },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(comparisonBranch).toBe('origin/main');
  });

  it('falls back to the project branch when no remote default ref exists', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command.includes('symbolic-ref')) {
        throw new Error('No remote default');
      }
      if (command === 'git branch --show-current' && cwd === '/repo') {
        return { stdout: 'feature/local\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const comparisonBranch = await manager.getSessionComparisonBranch(
      { baseBranch: 'HEAD', worktreePath: '/repo/worktrees/pane' },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(comparisonBranch).toBe('feature/local');
  });

  it('preserves current-branch origin comparison for a main-repo session', async () => {
    const runner = commandRunner(async command => {
      if (command === 'git branch --show-current') {
        return { stdout: 'feature/local\n', stderr: '' };
      }
      if (command === 'git rev-parse --verify origin/feature/local') {
        return { stdout: 'abc123\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const comparisonBranch = await manager.getSessionComparisonBranch(
      { baseBranch: 'HEAD', isMainRepo: true, worktreePath: '/repo' },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(comparisonBranch).toBe('origin/feature/local');
  });
});

describe('WorktreeManager.getSessionLocalBaseBranch', () => {
  it('keeps legacy write operations on the project checkout branch', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command === 'git branch --show-current' && cwd === '/repo') {
        return { stdout: 'release\n', stderr: '' };
      }
      if (command === 'git remote' && cwd === '/repo') {
        return { stdout: 'origin\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const localBaseBranch = await manager.getSessionLocalBaseBranch(
      {
        baseBranch: 'HEAD',
        baseCommit: 'pane-start-commit',
        worktreePath: '/repo/worktrees/pane',
      },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(localBaseBranch).toBe('release');
    expect(runner.execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining('symbolic-ref'),
      expect.any(String),
    );
  });

  it('strips the remote from an explicitly selected write target', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command === 'git branch --show-current' && cwd === '/repo/worktrees/pane') {
        return { stdout: 'pane-branch\n', stderr: '' };
      }
      if (command === 'git remote' && cwd === '/repo') {
        return { stdout: 'origin\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const localBaseBranch = await manager.getSessionLocalBaseBranch(
      { baseBranch: 'origin/release', worktreePath: '/repo/worktrees/pane' },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(localBaseBranch).toBe('release');
  });

  it('uses the project branch when an existing-branch pane stored its own branch as the base', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command === 'git branch --show-current' && cwd === '/repo/worktrees/pane') {
        return { stdout: 'pane-branch\n', stderr: '' };
      }
      if (command === 'git branch --show-current' && cwd === '/repo') {
        return { stdout: 'release\n', stderr: '' };
      }
      if (command === 'git remote' && cwd === '/repo') {
        return { stdout: 'origin\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const localBaseBranch = await manager.getSessionLocalBaseBranch(
      {
        baseBranch: 'pane-branch',
        baseCommit: 'pane-start-commit',
        worktreePath: '/repo/worktrees/pane',
      },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(localBaseBranch).toBe('release');
  });
});
