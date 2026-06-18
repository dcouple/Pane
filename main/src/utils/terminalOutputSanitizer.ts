/* eslint-disable no-control-regex -- Terminal output cleanup needs control-character patterns. */
const ANSI_PATTERNS: RegExp[] = [
  /\x1b\[[0-9;?]*[ -/]*[@-~]/g,
  /\x1b\].*?(?:\x07|\x1b\\)/g,
  /\x1b[()][AB012]/g,
  /\x1b[@-Z\\-_]/g,
  /[^\n]*\r(?!\n)/g,
  /\x1b/g,
];
/* eslint-enable no-control-regex */

const DEGRADED_XTERM_MODE_PATTERN = /\[\?[0-9;]+[hl]/g;

export function sanitizeTerminalOutput(text: string): string {
  let result = text;
  for (const pattern of ANSI_PATTERNS) {
    result = result.replace(pattern, '');
  }

  return result.replace(DEGRADED_XTERM_MODE_PATTERN, '');
}
