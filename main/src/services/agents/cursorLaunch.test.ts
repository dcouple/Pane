import { describe, expect, it } from 'vitest';
import {
  CURSOR_CHAT_ID_MARKER,
  buildCursorLaunchCommand,
  createCursorReadyDetector,
  extractCursorChatId,
} from './cursorLaunch';

const BASE = 'cursor-agent --force --trust';
const CHAT_ID = '7403f755-6758-40d3-bb69-2cd356dd9bf0';

describe('buildCursorLaunchCommand', () => {
  it('composes a create-chat compound that degrades to a plain launch', () => {
    expect(buildCursorLaunchCommand({ baseCommand: BASE })).toBe(
      'if __PANE_CURSOR_CHAT="$(cursor-agent create-chat 2>/dev/null)" && [ -n "$__PANE_CURSOR_CHAT" ]; '
      + `then printf '\\n${CURSOR_CHAT_ID_MARKER} %s\\n' "$__PANE_CURSOR_CHAT"; `
      + `${BASE} --resume "$__PANE_CURSOR_CHAT"; `
      + `else ${BASE}; fi`,
    );
  });

  it('appends the quoted prompt argument to both branches', () => {
    const command = buildCursorLaunchCommand({ baseCommand: BASE, promptArgument: 'Read "the guide" for $HOME' });
    const quoted = '"Read \\"the guide\\" for \\$HOME"';
    expect(command).toContain(`--resume "$__PANE_CURSOR_CHAT" ${quoted}; `);
    expect(command).toContain(`else ${BASE} ${quoted}; fi`);
  });

  it('derives the create-chat executable from the base command token', () => {
    const command = buildCursorLaunchCommand({ baseCommand: '/opt/bin/cursor-agent --force' });
    expect(command).toContain('"$(/opt/bin/cursor-agent create-chat 2>/dev/null)"');
  });

  it('composes fish syntax when the configured interactive shell is fish', () => {
    expect(buildCursorLaunchCommand({ baseCommand: BASE, shellType: 'fish' })).toBe(
      'if set __PANE_CURSOR_CHAT (cursor-agent create-chat 2>/dev/null); and test -n "$__PANE_CURSOR_CHAT"; '
      + `printf '\\n${CURSOR_CHAT_ID_MARKER} %s\\n' "$__PANE_CURSOR_CHAT"; `
      + `${BASE} --resume "$__PANE_CURSOR_CHAT"; `
      + `else; ${BASE}; end`,
    );
  });

  it('resumes a known chat id directly, without the create-chat compound', () => {
    expect(buildCursorLaunchCommand({ baseCommand: BASE, resumeChatId: CHAT_ID })).toBe(
      `${BASE} --resume "${CHAT_ID}"`,
    );
  });
});

describe('createCursorReadyDetector', () => {
  it('stays quiet through shell echo and create-chat output, then fires on the TUI title', () => {
    const isReady = createCursorReadyDetector();
    expect(isReady('if __PANE_CURSOR_CHAT="$(cursor-agent create-chat 2>/dev/null)"...\r\n')).toBe(false);
    expect(isReady(`pane-cursor-chat-id: ${CHAT_ID}\r\n`)).toBe(false);
    expect(isReady('\x1b[?25l\x1b[?2004h\x1b]0;Cursor Agent\x07\x1b[?2031h')).toBe(true);
  });

  it('detects the title even when it is split across chunks', () => {
    const isReady = createCursorReadyDetector();
    expect(isReady('\x1b]0;Cursor')).toBe(false);
    expect(isReady(' Agent\x07')).toBe(true);
  });
});

describe('extractCursorChatId', () => {
  it('finds the chat id on the printed marker line', () => {
    expect(extractCursorChatId(`\r\n${CURSOR_CHAT_ID_MARKER} ${CHAT_ID}\r\n`)).toBe(CHAT_ID);
  });

  it('ignores the shell echo of the compound command, which carries the literal %s', () => {
    const echo = `if __PANE_CURSOR_CHAT="$(cursor-agent create-chat 2>/dev/null)" && [ -n "$__PANE_CURSOR_CHAT" ]; then printf '\\n${CURSOR_CHAT_ID_MARKER} %s\\n' "$__PANE_CURSOR_CHAT"; ...`;
    expect(extractCursorChatId(echo)).toBeUndefined();
  });

  it('tolerates ANSI sequences around the marker', () => {
    const output = `\x1b[32m${CURSOR_CHAT_ID_MARKER}\x1b[0m \x1b[1m${CHAT_ID}\x1b[22m`;
    expect(extractCursorChatId(output)).toBe(CHAT_ID);
  });

  it('rejects non-uuid payloads', () => {
    expect(extractCursorChatId(`${CURSOR_CHAT_ID_MARKER} not-a-chat-id`)).toBeUndefined();
    expect(extractCursorChatId('')).toBeUndefined();
  });
});
