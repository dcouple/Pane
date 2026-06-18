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

const DEGRADED_XTERM_FRAGMENT = String.raw`\[\?(?:25|2004)[hl]`;
const DEGRADED_XTERM_LINE_START_PATTERN = new RegExp(`(^|\\n)(?:${DEGRADED_XTERM_FRAGMENT}){2,}`, 'g');
const DEGRADED_XTERM_LINE_END_PATTERN = new RegExp(`(?:${DEGRADED_XTERM_FRAGMENT}){2,}(?=\\n|$)`, 'g');
const DEGRADED_BRACKETED_PASTE_AFTER_PROMPT_PATTERN = new RegExp(`([>$#%])\\s*(?:\\[\\?2004[hl])+(?=\\S)`, 'g');

export function sanitizeTerminalOutput(text: string): string {
  let result = text;
  for (const pattern of ANSI_PATTERNS) {
    result = result.replace(pattern, '');
  }

  return result
    .replace(DEGRADED_XTERM_LINE_START_PATTERN, '$1')
    .replace(DEGRADED_XTERM_LINE_END_PATTERN, '')
    .replace(DEGRADED_BRACKETED_PASTE_AFTER_PROMPT_PATTERN, '$1 ');
}
