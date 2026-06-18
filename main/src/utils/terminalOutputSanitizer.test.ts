import { describe, expect, it } from 'vitest';
import { sanitizeTerminalOutput } from './terminalOutputSanitizer';

describe('sanitizeTerminalOutput', () => {
  it('strips ANSI sequences and degraded xterm mode fragments', () => {
    const input = [
      '\x1b[31mred\x1b[0m',
      '[?25h[?2004hprompt$ [?2004lecho hello',
      'hello[?25l[?25h',
    ].join('\n');

    expect(sanitizeTerminalOutput(input)).toBe([
      'red',
      'prompt$ echo hello',
      'hello',
    ].join('\n'));
  });

  it('keeps ordinary bracketed output intact', () => {
    expect(sanitizeTerminalOutput('result [ok] [?not-a-mode] [123h]\n')).toBe(
      'result [ok] [?not-a-mode] [123h]\n',
    );
  });

  it('keeps literal xterm-looking text intact', () => {
    expect(sanitizeTerminalOutput('docs mention [?25h and [?2004l fragments\n')).toBe(
      'docs mention [?25h and [?2004l fragments\n',
    );
  });
});
