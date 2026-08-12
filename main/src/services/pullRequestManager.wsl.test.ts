import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { PullRequestManager, quoteArg, resolveBodyFile } from './pullRequestManager';
import { escapeShellArg } from '../utils/shellEscape';
import type { CommandRunner } from '../utils/commandRunner';

/**
 * A WSL project runs its commands as `wsl.exe -d <distro> -- bash -c <command>`,
 * so the target shell is bash even when the host is Windows. Two things went
 * wrong there and both are guarded here:
 *
 * 1. Arguments were quoted by `escapeShellArg`, which picks its style from
 *    `process.platform` and hands bash double quotes on a Windows host —
 *    leaving `$`, backticks and `\` live inside them.
 * 2. The pull request body was written to the *host's* temp directory and its
 *    Windows path passed to a `gh` running inside the distro, which cannot open
 *    it.
 */

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, writeFileSync: vi.fn(), unlinkSync: vi.fn() };
});

/** A branch name git accepts and bash would otherwise execute. */
const HOSTILE_BRANCH = 'fix-`whoami`-$(id)';

function stubRunner(
  responses: Array<[match: string, output: string | Error]>,
  distribution: string | null,
): CommandRunner {
  const pick = (command: string) => {
    const plain = command.replace(/["']/g, '');
    for (const [match, output] of responses) {
      if (plain.includes(match)) return output;
    }
    return '';
  };
  return {
    exec: vi.fn((command: string) => {
      const output = pick(command);
      if (output instanceof Error) throw output;
      return output;
    }),
    execAsync: vi.fn(async (command: string) => {
      const output = pick(command);
      if (output instanceof Error) throw output;
      return { stdout: output, stderr: '' };
    }),
    wslContext: distribution ? { enabled: true, distribution, linuxPath: '/home/dev/p' } : null,
  } as unknown as CommandRunner;
}

describe('quoteArg', () => {
  it('quotes for bash when the command is bound for a WSL distro', () => {
    const wsl = { wslContext: { distribution: 'Ubuntu' } };

    // Single quotes are the only form bash expands nothing inside.
    expect(quoteArg(wsl, HOSTILE_BRANCH)).toBe("'fix-`whoami`-$(id)'");
    expect(quoteArg(wsl, "it's")).toBe("'it'\\''s'");
    expect(quoteArg(wsl, '')).toBe("''");
  });

  it('leaves nothing outside the quotes for bash to interpret', () => {
    const quoted = quoteArg({ wslContext: { distribution: 'Ubuntu' } }, HOSTILE_BRANCH);

    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // The dangerous characters survive as literals, not as syntax: the only
    // quote characters in the result are the two that wrap it.
    expect(quoted.slice(1, -1)).toBe(HOSTILE_BRANCH);
    expect(quoted.slice(1, -1)).not.toContain("'");
  });

  /**
   * The regression, stated so it holds on any test host: the old code asked
   * `process.platform`, and on a Windows host that answered with double quotes
   * for a command bash was about to run.
   */
  it('ignores the host platform — the distro decides the shell', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      expect(escapeShellArg(HOSTILE_BRANCH)).toContain('"');
      expect(quoteArg({ wslContext: { distribution: 'Ubuntu' } }, HOSTILE_BRANCH))
        .toBe("'fix-`whoami`-$(id)'");
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('defers to the platform-aware escape when there is no distro', () => {
    const host = { wslContext: null };
    const quoted = quoteArg(host, HOSTILE_BRANCH);

    // Whichever style the host uses, the value has to come back out whole.
    expect(quoted).toContain(HOSTILE_BRANCH.replace(/\\/g, '\\\\'));
    expect(quoted).not.toBe(HOSTILE_BRANCH);
  });
});

describe('resolveBodyFile', () => {
  it('puts the body where gh inside the distro can read it', () => {
    const { writePath, ghPath } = resolveBodyFile('Ubuntu', 'pane-pr-1.md');

    expect(ghPath).toBe('/tmp/pane-pr-1.md');
    expect(writePath).toBe('\\\\wsl.localhost\\Ubuntu\\tmp\\pane-pr-1.md');
    // The regression: a Windows temp path is meaningless inside the distro.
    expect(ghPath).not.toMatch(/^[A-Za-z]:/);
  });

  it('uses the host temp directory when nothing crosses a boundary', () => {
    const { writePath, ghPath } = resolveBodyFile(null, 'pane-pr-2.md');

    expect(writePath).toBe(ghPath);
    expect(ghPath.startsWith(tmpdir())).toBe(true);
  });
});

/**
 * The `gh pr create` command as it was actually issued. Every argument is
 * quoted separately, so `pr create` never appears as those two words in a row —
 * matching has to happen on the unquoted text and read the original back.
 */
function ghCreateCommand(commandRunner: CommandRunner): string {
  const commands = (commandRunner.execAsync as unknown as { mock: { calls: string[][] } }).mock.calls
    .map(call => call[0]);
  const index = commands.findIndex(text => text.replace(/['"]/g, '').includes('pr create'));
  expect(index).toBeGreaterThanOrEqual(0);
  return commands[index];
}

describe('PullRequestManager.create on a WSL project', () => {
  beforeEach(() => vi.clearAllMocks());

  const runner = () => stubRunner([
    ['branch --show-current', `${HOSTILE_BRANCH}\n`],
    ['git remote get-url', 'https://github.com/0x92/Pane.git\n'],
    ['git remote', 'origin\n'],
    ['git push', ''],
    ['--version', 'gh version 2.97.0'],
    ['pr create', 'https://github.com/dcouple/Pane/pull/391\n'],
  ], 'Ubuntu');

  const create = (commandRunner: CommandRunner) => new PullRequestManager().create(
    {
      sessionId: 's1',
      title: 'Add `date` support for $HOME',
      body: '# Body\n\n`code` and $vars stay markdown.\n',
      baseBranch: 'main',
      targetRepo: 'dcouple/Pane',
    },
    '/home/dev/p/wt', '/home/dev/p', commandRunner,
  );

  it('never lets a branch name become bash syntax', async () => {
    const commandRunner = runner();
    await create(commandRunner);

    const commands = (commandRunner.execAsync as unknown as { mock: { calls: string[][] } }).mock.calls
      .map(call => call[0]);

    const push = commands.find(command => command.includes('git push'))!;
    expect(push).toContain(`'${HOSTILE_BRANCH}'`);
    // Double quotes would leave the backtick and $( ) live for bash.
    expect(push).not.toContain('"');
  });

  it('quotes the title the same way, wherever the user put a backtick', async () => {
    const commandRunner = runner();
    await create(commandRunner);

    const command = ghCreateCommand(commandRunner);

    expect(command).toContain("'Add `date` support for $HOME'");
    expect(command).not.toContain('"');
  });

  it('gives gh a path that exists inside the distro, and writes the file there', async () => {
    const commandRunner = runner();
    await create(commandRunner);

    const command = ghCreateCommand(commandRunner);

    const bodyFile = /--body-file' '([^']+)'/.exec(command)?.[1];
    expect(bodyFile).toMatch(/^\/tmp\/pane-pr-[0-9a-f-]+\.md$/);

    const written = vi.mocked(writeFileSync).mock.calls[0];
    expect(written[0]).toBe(`\\\\wsl.localhost\\Ubuntu\\tmp\\${bodyFile!.slice('/tmp/'.length)}`);
    expect(written[1]).toContain('`code` and $vars stay markdown.');
  });

  it('removes the temp file it wrote, not some host path', async () => {
    const commandRunner = runner();
    await create(commandRunner);

    expect(vi.mocked(unlinkSync).mock.calls[0][0]).toBe(vi.mocked(writeFileSync).mock.calls[0][0]);
  });

  it('cleans up even when gh fails', async () => {
    const commandRunner = stubRunner([
      ['branch --show-current', `${HOSTILE_BRANCH}\n`],
      ['git remote', 'origin\n'],
      ['git push', ''],
      ['--version', 'gh version 2.97.0'],
      ['pr create', new Error('gh: pull request already exists')],
    ], 'Ubuntu');

    await expect(create(commandRunner)).rejects.toThrow();
    expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(vi.mocked(writeFileSync).mock.calls[0][0]);
  });
});

describe('PullRequestManager.create on a host project', () => {
  beforeEach(() => vi.clearAllMocks());

  it('still writes to the host temp directory', async () => {
    const commandRunner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git remote', 'origin\n'],
      ['git push', ''],
      ['--version', 'gh version 2.97.0'],
      ['pr create', 'https://github.com/dcouple/Pane/pull/392\n'],
    ], null);

    await new PullRequestManager().create(
      { sessionId: 's1', title: 't', body: 'b', baseBranch: 'main', targetRepo: 'dcouple/Pane' },
      '/wt', '/repo', commandRunner,
    );

    const written = String(vi.mocked(writeFileSync).mock.calls[0][0]);
    expect(written.startsWith(tmpdir())).toBe(true);
  });
});
