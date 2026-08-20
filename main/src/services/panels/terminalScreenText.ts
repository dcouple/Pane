import { sanitizeTerminalOutput } from '../../utils/terminalOutputSanitizer';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { TerminalPanelState } from '../../../../shared/types/panels';
import type { TerminalPanelSnapshot } from '../terminalPanelManager';
import type { RunpanePanelScreenSource } from '../../../../shared/types/runpaneOrchestration';

/**
 * Shared plain-text extraction for terminal panels.
 *
 * Two very different consumers need the same answer to "what does this
 * terminal currently show as text?": the RunPane CLI (`panels screen`) and the
 * Mission Control's snapshot tiles. Keeping one implementation means a fix to the
 * alternate-screen / persisted-buffer precedence benefits both.
 */

export function normalizeScrollbackBuffer(value: TerminalPanelState['scrollbackBuffer']): string {
  if (Array.isArray(value)) return value.join('\n');
  return decodeOptionalBoundary(value, boundary.string) ?? '';
}

export interface PanelScreenText {
  source: RunpanePanelScreenSource;
  rawText: string;
}

/**
 * Pick the best available text for a panel, preferring the live emulator's
 * viewport and falling back to persisted buffers for panels with no PTY.
 */
export function selectPanelScreenText(
  snapshot: TerminalPanelSnapshot | null,
  customState: TerminalPanelState,
): PanelScreenText {
  if (snapshot) {
    if (snapshot.screenText !== undefined) {
      return {
        source: snapshot.isAlternateScreen ? 'alternateScreen' : 'scrollback',
        rawText: snapshot.screenText,
      };
    }
    if (snapshot.isAlternateScreen && snapshot.alternateScreenBuffer) {
      return { source: 'alternateScreen', rawText: snapshot.alternateScreenBuffer };
    }
    if (snapshot.scrollbackBuffer) {
      return { source: 'scrollback', rawText: snapshot.scrollbackBuffer };
    }
    return { source: 'empty', rawText: '' };
  }

  const persistedAlternate = customState.alternateScreenBuffer;
  if (customState.isAlternateScreen && persistedAlternate) {
    return { source: 'persistedOutput', rawText: persistedAlternate };
  }

  const persistedScrollback = normalizeScrollbackBuffer(customState.scrollbackBuffer);
  if (persistedScrollback) {
    return { source: 'persistedOutput', rawText: persistedScrollback };
  }

  return { source: 'empty', rawText: '' };
}

export interface BoundedSanitizedLines {
  text: string;
  hasMore: boolean;
  returnedLineCount: number;
}

/** Strip ANSI and keep at most the last `limit` lines. */
export function boundSanitizedLines(rawText: string, limit: number): BoundedSanitizedLines {
  const stripped = sanitizeTerminalOutput(rawText);
  if (!stripped) {
    return { text: '', hasMore: false, returnedLineCount: 0 };
  }

  const allLines = stripped.split('\n');
  const hasMore = allLines.length > limit;
  const lines = hasMore ? allLines.slice(-limit) : allLines;
  return {
    text: lines.join('\n'),
    hasMore,
    returnedLineCount: lines.length,
  };
}
