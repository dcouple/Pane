import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { worktreeFileSyncService } from '../worktreeFileSyncService';
import type { WorktreeFileSyncEntry } from '../../../../shared/types/worktreeFileSync';
import type { CommandRunner } from '../../utils/commandRunner';
import type { ProjectEnvironment } from '../../utils/pathResolver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a mock CommandRunner whose execAsync routes on command prefix.
 *
 * `findOutput`    – what `find ...` / `dir /s /b` returns (newline-separated paths)
 * `existingDests` – set of destination paths that should appear to exist
 *                   (so the copy is skipped for those)
 * `cpCommands`    – array populated with each `cp` / `copy` / `robocopy` command
 *                   string executed during the run
 */
function makeMockCommandRunner(
  findOutput: string,
  existingDests: ReadonlySet<string>,
  cpCommands: string[],
): CommandRunner {
  const execAsync = vi.fn().mockImplementation((cmd: string, _cwd: string) => {
    if (cmd.startsWith('find ') || cmd.startsWith('dir /')) {
      return Promise.resolve({ stdout: findOutput, stderr: '' });
    }
    if (cmd.startsWith('test -e ')) {
      // Extract the quoted path from `test -e "..."`
      const match = /^test -e "(.+)"$/.exec(cmd);
      const testedPath = match ? match[1] : '';
      if (existingDests.has(testedPath)) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.reject(new Error('not exists'));
    }
    if (cmd.startsWith('test -f ')) {
      // All matched .env* paths are files; node_modules are directories
      const match = /^test -f "(.+)"$/.exec(cmd);
      const testedPath = match ? match[1] : '';
      const isFile = !testedPath.endsWith('node_modules');
      if (isFile) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.reject(new Error('not a file'));
    }
    if (cmd.startsWith('mkdir ')) {
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (
      cmd.startsWith('cp ') ||
      cmd.startsWith('copy ') ||
      cmd.startsWith('robocopy ')
    ) {
      cpCommands.push(cmd);
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  });

  return { execAsync } as unknown as CommandRunner;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const envEntry: WorktreeFileSyncEntry = {
  id: 'env',
  path: '.env*',
  enabled: true,
  recursive: true,
};
const nodeModulesEntry: WorktreeFileSyncEntry = {
  id: 'node_modules',
  path: 'node_modules',
  enabled: true,
  recursive: true,
};
const claudeEntry: WorktreeFileSyncEntry = {
  id: 'claude',
  path: '.claude',
  enabled: true,
  recursive: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worktreeFileSyncService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // WSL environment
  //
  // These tests verify that the service produces correct POSIX destination
  // paths for nested files when environment is 'wsl'.
  //
  // NOTE ON THE BUG: On a Windows host, `path.relative` returns backslash
  // paths (e.g. `apps\api\.env`). The fix uses `path.posix.relative` for WSL
  // so the relative path always uses forward slashes. However, on Linux (the
  // test host) `path.posix` and `path` share the same implementation, so we
  // cannot simulate the Windows bug via a spy without infinite recursion.
  //
  // These tests instead verify the end-to-end behaviour: that the correct
  // POSIX cp commands are generated for nested paths when environment='wsl'.
  // -------------------------------------------------------------------------

  describe('WSL environment', () => {
    const environment: ProjectEnvironment = 'wsl';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    it('copies a nested .env.example with the correct POSIX destination path', async () => {
      const findOutput = `/home/user/repo/apps/api/.env.example`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/apps/api/.env.example" "/home/user/worktree/apps/api/.env.example"',
      );
    });

    it('copies multiple nested .env files across different sub-packages', async () => {
      const findOutput = [
        '/home/user/repo/apps/api/.env.example',
        '/home/user/repo/apps/web/.env.local',
        '/home/user/repo/.env',
      ].join('\n');
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(3);
      expect(cpCommands).toContain(
        'cp "/home/user/repo/apps/api/.env.example" "/home/user/worktree/apps/api/.env.example"',
      );
      expect(cpCommands).toContain(
        'cp "/home/user/repo/apps/web/.env.local" "/home/user/worktree/apps/web/.env.local"',
      );
      expect(cpCommands).toContain(
        'cp "/home/user/repo/.env" "/home/user/worktree/.env"',
      );
    });

    it('copies a deeply nested .env.local file', async () => {
      const findOutput = `/home/user/repo/packages/app/config/.env.local`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/packages/app/config/.env.local" "/home/user/worktree/packages/app/config/.env.local"',
      );
    });

    it('copies nested node_modules directories with correct POSIX destination paths', async () => {
      const findOutput = [
        '/home/user/repo/node_modules',
        '/home/user/repo/packages/app/node_modules',
      ].join('\n');
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [nodeModulesEntry],
      );

      expect(cpCommands).toHaveLength(2);
      expect(cpCommands).toContain(
        'cp -rp "/home/user/repo/node_modules" "/home/user/worktree/node_modules"',
      );
      expect(cpCommands).toContain(
        'cp -rp "/home/user/repo/packages/app/node_modules" "/home/user/worktree/packages/app/node_modules"',
      );
    });

    it('skips copying when destination already exists', async () => {
      const findOutput = `/home/user/repo/apps/api/.env.example`;
      const cpCommands: string[] = [];
      const existingDests = new Set([
        '/home/user/worktree/apps/api/.env.example',
      ]);
      const runner = makeMockCommandRunner(findOutput, existingDests, cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(0);
    });

    it('handles empty find results gracefully without throwing', async () => {
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner('', new Set(), cpCommands);

      await expect(
        worktreeFileSyncService.syncWorktree(
          mainRepoPath,
          worktreePath,
          runner,
          environment,
          [envEntry],
        ),
      ).resolves.not.toThrow();

      expect(cpCommands).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Linux environment
  // -------------------------------------------------------------------------

  describe('Linux environment', () => {
    const environment: ProjectEnvironment = 'linux';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    it('copies a nested .env file using native POSIX paths', async () => {
      const findOutput = `/home/user/repo/apps/api/.env`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/apps/api/.env" "/home/user/worktree/apps/api/.env"',
      );
    });

    it('copies a root-level .env file on Linux', async () => {
      const findOutput = `/home/user/repo/.env`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/.env" "/home/user/worktree/.env"',
      );
    });
  });

  // -------------------------------------------------------------------------
  // macOS environment
  // -------------------------------------------------------------------------

  describe('macOS environment', () => {
    const environment: ProjectEnvironment = 'macos';
    const mainRepoPath = '/Users/user/repo';
    const worktreePath = '/Users/user/worktree';

    it('copies a nested .env file on macOS', async () => {
      const findOutput = `/Users/user/repo/apps/api/.env`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      // Files use plain cp on all POSIX platforms
      expect(cpCommands[0]).toBe(
        'cp "/Users/user/repo/apps/api/.env" "/Users/user/worktree/apps/api/.env"',
      );
    });

    it('copies a nested node_modules directory using macOS APFS clone command', async () => {
      const findOutput = `/Users/user/repo/packages/lib/node_modules`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [nodeModulesEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp -c -R "/Users/user/repo/packages/lib/node_modules" "/Users/user/worktree/packages/lib/node_modules"',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Root-level (non-recursive) entries
  // -------------------------------------------------------------------------

  describe('root-level non-recursive entries', () => {
    const environment: ProjectEnvironment = 'linux';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    it('copies .claude directory as a root-level entry', async () => {
      const cpCommands: string[] = [];

      // For non-recursive entries the runner is called with existsAt checks,
      // not find. Simulate: src exists, dest does not exist, src is a directory.
      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'test -e "/home/user/repo/.claude"') {
          // source exists
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd === 'test -e "/home/user/worktree/.claude"') {
          // destination does not exist
          return Promise.reject(new Error('not exists'));
        }
        if (cmd.startsWith('test -f ')) {
          // .claude is a directory — test -f fails
          return Promise.reject(new Error('not a file'));
        }
        if (cmd.startsWith('mkdir ')) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.startsWith('cp ')) {
          cpCommands.push(cmd);
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const runner = { execAsync } as unknown as CommandRunner;

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [claudeEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp -rp "/home/user/repo/.claude" "/home/user/worktree/.claude"',
      );
    });

    it('skips root-level entry when destination already exists', async () => {
      const cpCommands: string[] = [];

      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.startsWith('test -e ')) {
          // Both source and dest exist
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.startsWith('cp ')) {
          cpCommands.push(cmd);
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const runner = { execAsync } as unknown as CommandRunner;

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [claudeEntry],
      );

      expect(cpCommands).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Disabled entries
  // -------------------------------------------------------------------------

  describe('disabled entries', () => {
    it('skips disabled entries entirely', async () => {
      const environment: ProjectEnvironment = 'linux';
      const mainRepoPath = '/home/user/repo';
      const worktreePath = '/home/user/worktree';
      const cpCommands: string[] = [];

      const disabledEntry: WorktreeFileSyncEntry = {
        ...envEntry,
        enabled: false,
      };

      const runner = makeMockCommandRunner(
        '/home/user/repo/.env',
        new Set(),
        cpCommands,
      );

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [disabledEntry],
      );

      expect(cpCommands).toHaveLength(0);
    });
  });
});
