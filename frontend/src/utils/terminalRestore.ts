import type { TerminalPanelState } from '../../../shared/types/panels';

export type TerminalRestoreSource = 'alternateScreen' | 'scrollback' | 'serialized';

export interface TerminalRestoreContent {
  content: string;
  source: TerminalRestoreSource;
}

function normalizeScrollback(scrollback: TerminalPanelState['scrollbackBuffer']): string {
  if (typeof scrollback === 'string') return scrollback;
  if (Array.isArray(scrollback)) return scrollback.join('\n');
  return '';
}

/** Select the buffer that represents the live terminal's active screen. */
export function selectTerminalRestoreContent(state: TerminalPanelState): TerminalRestoreContent | null {
  if (state.isAlternateScreen) {
    if (state.serializedBuffer) {
      return { content: state.serializedBuffer, source: 'serialized' };
    }
    if (state.alternateScreenBuffer) {
      return { content: state.alternateScreenBuffer, source: 'alternateScreen' };
    }
  }

  const scrollback = normalizeScrollback(state.scrollbackBuffer);
  if (scrollback) {
    return { content: scrollback, source: 'scrollback' };
  }
  if (state.serializedBuffer) {
    return { content: state.serializedBuffer, source: 'serialized' };
  }
  return null;
}
