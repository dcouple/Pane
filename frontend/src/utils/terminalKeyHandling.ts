export const TERMINAL_MULTILINE_NEWLINE_SEQUENCE = '\x1b\r';

export type TerminalKeyHandlingDecision =
  | { action: 'continue' }
  | { action: 'release-to-app' }
  | { action: 'pass-through' }
  | { action: 'block' }
  | { action: 'send-input'; input: string };

export interface TerminalKeyHandlingState {
  isTuiActive: boolean;
  isCliPanel: boolean;
  isMac: boolean;
}

export interface TerminalKeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  getModifierState: (key: string) => boolean;
}

function isPaneNavigationShortcut(
  event: TerminalKeyLike,
  state: TerminalKeyHandlingState,
): boolean {
  const primaryModifier = state.isMac ? event.metaKey : event.ctrlKey;
  if (!primaryModifier) return false;

  const isAltGr = event.getModifierState('AltGraph');
  const digitMatch = event.code.match(/^Digit([1-9])$/);
  const isUnreportedAltGrDigit = !state.isMac
    && event.ctrlKey
    && event.altKey
    && digitMatch
    && event.key !== digitMatch[1];
  if (
    event.altKey
    && !isAltGr
    && !isUnreportedAltGrDigit
    && !event.shiftKey
    && (
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      || digitMatch
    )
  ) {
    return true;
  }

  if (!event.altKey && event.key === 'Tab') return true;
  if (!event.altKey && event.shiftKey && /^Digit[1-9]$/.test(event.code)) return true;
  if (!event.altKey && event.shiftKey && event.key.toLowerCase() === 'z') return true;

  const isBackslash = event.code === 'Backslash' || event.code === 'IntlBackslash';
  return !event.altKey && isBackslash;
}

export function resolveTerminalKeyHandling(
  event: TerminalKeyLike,
  state: TerminalKeyHandlingState,
): TerminalKeyHandlingDecision {
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const shiftEnter = event.shiftKey && !ctrlOrMeta && event.key === 'Enter';

  if (shiftEnter && (!state.isTuiActive || state.isCliPanel)) {
    return { action: 'send-input', input: TERMINAL_MULTILINE_NEWLINE_SEQUENCE };
  }

  if (state.isTuiActive && isPaneNavigationShortcut(event, state)) {
    return { action: 'release-to-app' };
  }

  if (state.isTuiActive) {
    if (ctrlOrMeta && event.key.toLowerCase() === 'v') {
      return { action: 'block' };
    }

    return { action: 'pass-through' };
  }

  return { action: 'continue' };
}
