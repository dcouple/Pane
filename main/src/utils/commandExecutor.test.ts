import { describe, expect, it, vi } from 'vitest';
import { CommandExecutor } from './commandExecutor';

describe('CommandExecutor.execFileAsync', () => {
  it('builds one escaped bash command for the WSL branch', async () => {
    const fileExecutor = vi.fn(async () => ({ stdout: 'ok\n', stderr: '' }));
    const executor = new CommandExecutor(fileExecutor);

    const result = await executor.execFileAsync(
      'git',
      ['diff', '$HOME', "quote'arg"],
      {
        cwd: '/repo with space',
        env: { PANE_DIFF_TEST_ENV: 'value with space' },
        silent: true,
      },
      { enabled: true, distribution: 'Ubuntu-Test', linuxPath: '/repo with space' },
    );

    expect(result).toEqual({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    expect(fileExecutor).toHaveBeenCalledOnce();
    expect(fileExecutor).toHaveBeenCalledWith(
      'wsl.exe',
      [
        '-d',
        'Ubuntu-Test',
        '--',
        'bash',
        '-c',
        "export PANE_DIFF_TEST_ENV='value with space'; cd '/repo with space' && 'git' 'diff' '$HOME' 'quote'\\''arg'",
      ],
      expect.objectContaining({ cwd: undefined }),
    );
  });
});
