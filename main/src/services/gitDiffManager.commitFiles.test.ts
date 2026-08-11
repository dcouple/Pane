import { describe, it, expect, vi } from 'vitest';
import {
  GitDiffManager,
  parseNumstatZ,
  parseNameStatusZ,
  parseUntrackedPathsZ,
  mergeFileChanges,
  WORKING_TREE_REF,
  MAX_UNTRACKED_INLINE_FILES,
  chunkByCommandLength,
} from './gitDiffManager';
import type { CommandRunner } from '../utils/commandRunner';

/**
 * Builds a CommandRunner stub whose `exec` dispatches on a substring of the
 * command, so each test only has to describe the outputs it cares about.
 */
function stubRunner(responses: Array<[match: string, output: string]>): CommandRunner {
  const exec = vi.fn((command: string) => {
    for (const [match, output] of responses) {
      if (command.includes(match)) return output;
    }
    return '';
  });
  return { exec } as unknown as CommandRunner;
}

describe('parseNumstatZ', () => {
  it('parses plain add/modify/delete records', () => {
    const raw = '10\t2\tsrc/a.ts\0' + '0\t7\tsrc/b.ts\0' + '3\t0\tREADME.md\0';
    expect(parseNumstatZ(raw)).toEqual([
      { oldPath: 'src/a.ts', path: 'src/a.ts', additions: 10, deletions: 2, isBinary: false },
      { oldPath: 'src/b.ts', path: 'src/b.ts', additions: 0, deletions: 7, isBinary: false },
      { oldPath: 'README.md', path: 'README.md', additions: 3, deletions: 0, isBinary: false },
    ]);
  });

  it('parses a rename record with its two trailing path tokens', () => {
    const raw = '1\t1\t\0old/name.ts\0new/name.ts\0';
    expect(parseNumstatZ(raw)).toEqual([
      { oldPath: 'old/name.ts', path: 'new/name.ts', additions: 1, deletions: 1, isBinary: false },
    ]);
  });

  it('marks binary files with null counts', () => {
    const raw = '-\t-\tassets/logo.png\0';
    expect(parseNumstatZ(raw)).toEqual([
      { oldPath: 'assets/logo.png', path: 'assets/logo.png', additions: null, deletions: null, isBinary: true },
    ]);
  });

  it('keeps paths containing spaces, quotes and tabs intact', () => {
    const raw = '2\t0\tsrc/my "odd"\tname.ts\0';
    expect(parseNumstatZ(raw)).toEqual([
      { oldPath: 'src/my "odd"\tname.ts', path: 'src/my "odd"\tname.ts', additions: 2, deletions: 0, isBinary: false },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseNumstatZ('')).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  it('parses single-path statuses', () => {
    const raw = 'M\0src/a.ts\0' + 'A\0src/new.ts\0' + 'D\0src/gone.ts\0';
    expect(parseNameStatusZ(raw)).toEqual([
      { oldPath: 'src/a.ts', path: 'src/a.ts', status: 'modified' },
      { oldPath: 'src/new.ts', path: 'src/new.ts', status: 'added' },
      { oldPath: 'src/gone.ts', path: 'src/gone.ts', status: 'deleted' },
    ]);
  });

  it('parses renames with a similarity score and two paths', () => {
    const raw = 'R100\0old/name.ts\0new/name.ts\0';
    expect(parseNameStatusZ(raw)).toEqual([
      { oldPath: 'old/name.ts', path: 'new/name.ts', status: 'renamed', similarity: 100 },
    ]);
  });

  it('maps unknown status letters to "unknown"', () => {
    expect(parseNameStatusZ('X\0weird.ts\0')).toEqual([
      { oldPath: 'weird.ts', path: 'weird.ts', status: 'unknown' },
    ]);
  });
});

describe('parseUntrackedPathsZ', () => {
  it('returns only untracked entries and skips rename originals', () => {
    // Porcelain v1 with -z packs `XY path` into one token; renames add a
    // second token holding the original path.
    const raw = ' M tracked.ts\0' + 'R  renamed-new.ts\0renamed-old.ts\0' + '?? brand-new.ts\0';
    expect(parseUntrackedPathsZ(raw)).toEqual(['brand-new.ts']);
  });

  it('handles empty output', () => {
    expect(parseUntrackedPathsZ('')).toEqual([]);
  });
});

describe('mergeFileChanges', () => {
  it('takes counts from numstat and the change kind from name-status', () => {
    const numstat = parseNumstatZ('1\t1\t\0old.ts\0new.ts\0');
    const nameStatus = parseNameStatusZ('R95\0old.ts\0new.ts\0');
    expect(mergeFileChanges(numstat, nameStatus)).toEqual([
      {
        path: 'new.ts',
        oldPath: 'old.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        isBinary: false,
        similarity: 95,
      },
    ]);
  });

  it('falls back to "modified" when name-status has no matching path', () => {
    const merged = mergeFileChanges(parseNumstatZ('4\t1\tsrc/a.ts\0'), []);
    expect(merged[0].status).toBe('modified');
  });
});

describe('GitDiffManager.getCommitFileChanges', () => {
  it('lists files for a normal commit', () => {
    const runner = stubRunner([
      ['rev-list', 'abc123 parent1\n'],
      ['--numstat', '10\t2\tsrc/a.ts\0'],
      ['--name-status', 'M\0src/a.ts\0'],
    ]);

    const result = new GitDiffManager().getCommitFileChanges('/repo', 'abc123', runner);

    expect(result.ref).toBe('abc123');
    expect(result.isMergeAgainstFirstParent).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2 });
  });

  it('flags merge commits and diffs them against the first parent', () => {
    const runner = stubRunner([
      ['rev-list', 'merge1 parent1 parent2\n'],
      ['--numstat', '1\t0\tsrc/a.ts\0'],
      ['--name-status', 'M\0src/a.ts\0'],
    ]);

    const result = new GitDiffManager().getCommitFileChanges('/repo', 'merge1', runner);

    expect(result.isMergeAgainstFirstParent).toBe(true);
    const commands = (runner.exec as unknown as { mock: { calls: string[][] } }).mock.calls.map(call => call[0]);
    expect(commands.some(cmd => cmd.includes('--numstat') && cmd.includes('--first-parent'))).toBe(true);
  });

  it('truncates commits above the per-commit cap', () => {
    const numstat = Array.from({ length: 600 }, (_, i) => `1\t0\tfile${i}.ts\0`).join('');
    const runner = stubRunner([
      ['rev-list', 'big1 parent1\n'],
      ['--numstat', numstat],
      ['--name-status', ''],
    ]);

    const result = new GitDiffManager().getCommitFileChanges('/repo', 'big1', runner);

    expect(result.totalFiles).toBe(600);
    expect(result.files).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('includes untracked files without counts for the working tree', () => {
    const runner = stubRunner([
      ['git diff --numstat', '3\t1\ttracked.ts\0'],
      ['git diff --name-status', 'M\0tracked.ts\0'],
      ['status --porcelain', '?? untracked.ts\0'],
    ]);

    const result = new GitDiffManager().getCommitFileChanges('/repo', WORKING_TREE_REF, runner);

    expect(result.ref).toBe(WORKING_TREE_REF);
    expect(result.files).toHaveLength(2);
    expect(result.files[1]).toMatchObject({
      path: 'untracked.ts',
      status: 'added',
      additions: null,
      deletions: null,
    });
  });

  it('returns an empty result instead of throwing on git failure', () => {
    const runner = {
      exec: vi.fn(() => {
        throw new Error('fatal: bad revision');
      }),
    } as unknown as CommandRunner;

    const result = new GitDiffManager().getCommitFileChanges('/repo', 'nope', runner);

    expect(result.files).toEqual([]);
    expect(result.totalFiles).toBe(0);
  });
});

describe('chunkByCommandLength', () => {
  it('keeps every file and preserves order', () => {
    const files = Array.from({ length: 500 }, (_, i) => `src/some/nested/path/file-${i}.ts`);
    const batches = chunkByCommandLength(files);
    expect(batches.flat()).toEqual(files);
  });

  it('keeps each batch within the command-line budget', () => {
    const files = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`);
    for (const batch of chunkByCommandLength(files, 200)) {
      const rendered = batch.map(f => `"${f}"`).join(' ');
      // One over-long path may exceed the budget on its own; more may not.
      if (batch.length > 1) expect(rendered.length).toBeLessThanOrEqual(200);
    }
  });

  it('never drops a path longer than the whole budget', () => {
    const long = 'a'.repeat(500);
    expect(chunkByCommandLength([long], 100).flat()).toEqual([long]);
  });

  it('returns nothing for no files', () => {
    expect(chunkByCommandLength([])).toEqual([]);
  });
});

/**
 * These guard the freeze: a worktree carrying an unignored build tree used to
 * cost one child process per untracked file — twice over — on the main process.
 */
describe('working-directory capture is bounded and off the main thread', () => {
  function asyncRunner(untracked: string[], counters: { cat: number; wc: number; lsFiles: number }) {
    return {
      exec: vi.fn(() => ''),
      execAsync: vi.fn(async (command: string) => {
        if (command.startsWith('cat ')) {
          counters.cat++;
          return { stdout: 'hello\nworld', stderr: '' };
        }
        if (command.startsWith('wc -l ')) {
          counters.wc++;
          const paths = command.match(/"/g)?.length ?? 0;
          const fileCount = paths / 2;
          const lines = Array.from({ length: fileCount }, (_, i) => `  2 file${i}`).join('\n');
          return { stdout: `${lines}\n  ${fileCount * 2} total`, stderr: '' };
        }
        if (command.includes('ls-files --others')) {
          counters.lsFiles++;
          return { stdout: untracked.join('\n'), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
    } as unknown as CommandRunner;
  }

  it('caps content reads and batches line counts for a huge untracked set', async () => {
    const untracked = Array.from({ length: 5000 }, (_, i) => `app/build/res/values-${i}.arsc.flat`);
    const counters = { cat: 0, wc: 0, lsFiles: 0 };

    const result = await new GitDiffManager().captureWorkingDirectoryDiff('/repo', asyncRunner(untracked, counters));

    // Content inlining is capped...
    expect(counters.cat).toBeLessThanOrEqual(MAX_UNTRACKED_INLINE_FILES);
    // ...and 5000 line counts collapse into a handful of batched spawns,
    // where the old code spawned one process per file.
    expect(counters.wc).toBeGreaterThan(0);
    expect(counters.wc).toBeLessThan(100);
    // Every untracked file is still reported, even when its content is not.
    expect(result.changedFiles).toHaveLength(5000);
    expect(result.stats.filesChanged).toBe(5000);
  });

  it('lists untracked files exactly once per capture', async () => {
    const counters = { cat: 0, wc: 0, lsFiles: 0 };
    await new GitDiffManager().captureWorkingDirectoryDiff('/repo', asyncRunner(['a.ts', 'b.ts'], counters));
    expect(counters.lsFiles).toBe(1);
  });

  it('still inlines content for an ordinary number of untracked files', async () => {
    const counters = { cat: 0, wc: 0, lsFiles: 0 };
    const result = await new GitDiffManager().captureWorkingDirectoryDiff(
      '/repo',
      asyncRunner(['README.md', 'src/new.ts', 'notes.txt'], counters)
    );

    expect(counters.cat).toBe(3);
    expect(result.diff).toContain('README.md');
    expect(result.diff).toContain('+hello');
  });

  it('never blocks on the synchronous exec path', async () => {
    const counters = { cat: 0, wc: 0, lsFiles: 0 };
    const runner = asyncRunner(['a.ts'], counters);

    await new GitDiffManager().captureWorkingDirectoryDiff('/repo', runner);

    // Only getCurrentCommitHash stays sync; nothing that scales with file count.
    const syncCalls = (runner.exec as unknown as { mock: { calls: string[][] } }).mock.calls;
    expect(syncCalls.every(call => call[0].includes('rev-parse'))).toBe(true);
  });
});

describe('GitDiffManager.getCommitFileChanges error handling', () => {
  it('returns an empty result instead of throwing on git failure', () => {
    const runner = {
      exec: vi.fn(() => {
        throw new Error('fatal: bad revision');
      }),
    } as unknown as CommandRunner;

    const result = new GitDiffManager().getCommitFileChanges('/repo', 'nope', runner);

    expect(result.files).toEqual([]);
    expect(result.totalFiles).toBe(0);
  });
});
