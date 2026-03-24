import type {
  AtTerminalHandlerState,
  InterceptAction,
  InterceptHandler,
  TerminalSuggestion,
} from '../types';

interface AtTerminalHandlerOptions {
  sessionId: string;
  currentPanelId: string;
  getTerminals: () => Promise<TerminalSuggestion[]>;
  hasOtherTerminals: () => boolean; // fast sync check
  onCopy: (panelId: string, lines: number) => Promise<void>;
  onStateChange: () => void; // notify interceptor to re-render
}

function createDefaultState(): AtTerminalHandlerState {
  return {
    terminals: [],
    selectedIndex: 0,
    lineCount: 500,
    lineCountInput: '',
    isEditingLineCount: false,
  };
}

function filterTerminals(
  terminals: TerminalSuggestion[],
  filter: string,
): TerminalSuggestion[] {
  if (filter === '') {
    return terminals;
  }
  const lower = filter.toLowerCase();
  return terminals.filter((t) => t.title.toLowerCase().includes(lower));
}

export function createAtTerminalHandler(
  options: AtTerminalHandlerOptions,
): InterceptHandler {
  const { getTerminals, hasOtherTerminals, onCopy, onStateChange } = options;

  let state: AtTerminalHandlerState = createDefaultState();
  let filteredTerminals: TerminalSuggestion[] = [];
  let currentFilter: string = ''; // tracks the latest filter for async reapply
  let terminalsLoaded: boolean = false; // true once async getTerminals resolves

  const updateFiltered = (filter: string): void => {
    currentFilter = filter;
    filteredTerminals = filterTerminals(state.terminals, filter);
    // Clamp selectedIndex
    if (filteredTerminals.length > 0) {
      state = {
        ...state,
        selectedIndex: Math.min(
          state.selectedIndex,
          filteredTerminals.length - 1,
        ),
      };
    } else {
      state = { ...state, selectedIndex: 0 };
    }
  };

  return {
    onActivate(): boolean {
      if (!hasOtherTerminals()) {
        return false;
      }

      state = createDefaultState();
      filteredTerminals = [];
      terminalsLoaded = false;

      // Fire-and-forget: load terminals async, update state when done
      getTerminals()
        .then((terminals) => {
          terminalsLoaded = true;
          state = { ...state, terminals };
          // Reapply the current filter — the user may have typed while we were loading
          updateFiltered(currentFilter);
          onStateChange();
        })
        .catch(() => {
          // Silently ignore errors — terminals list stays empty
        });

      return true;
    },

    onInput(data: string, buffer: string): InterceptAction {
      switch (data) {
        case '\x1b[A': {
          // Arrow up
          const newIndex = Math.max(0, state.selectedIndex - 1);
          state = { ...state, selectedIndex: newIndex };
          onStateChange();
          return { type: 'consume' };
        }

        case '\x1b[B': {
          // Arrow down
          const maxIndex = Math.max(0, filteredTerminals.length - 1);
          const newIndexDown = Math.min(maxIndex, state.selectedIndex + 1);
          state = { ...state, selectedIndex: newIndexDown };
          onStateChange();
          return { type: 'consume' };
        }

        case '\r': {
          // Enter — execute copy on selected terminal
          const selected = filteredTerminals[state.selectedIndex];
          if (selected !== undefined) {
            onCopy(selected.panelId, state.lineCount).catch(() => {
              // Silently ignore copy errors
            });
          }
          return {
            type: 'execute',
            payload: { action: 'copy', data: {} },
          };
        }

        case '\x1b': {
          // Bare Escape
          return { type: 'cancel' };
        }

        case ' ': {
          // Space
          return { type: 'cancel' };
        }

        case '\x7f': {
          // Backspace
          if (state.isEditingLineCount && state.lineCountInput.length > 0) {
            // Remove last digit from line count input
            const newInput = state.lineCountInput.slice(0, -1);
            const parsed = parseInt(newInput, 10);
            const newLineCount = isNaN(parsed) ? 500 : parsed;
            state = {
              ...state,
              lineCountInput: newInput,
              lineCount: newLineCount,
            };
            onStateChange();
            return { type: 'consume' };
          }
          if (state.isEditingLineCount) {
            // Backspace with empty line count input — exit line count mode
            state = { ...state, isEditingLineCount: false };
            onStateChange();
            return { type: 'consume' };
          }
          if (buffer.length > 0) {
            // Remove last char from filter
            const newBuffer = buffer.slice(0, -1);
            updateFiltered(newBuffer);
            return { type: 'update', buffer: newBuffer };
          }
          // Backspace on empty filter — cancel
          return { type: 'cancel' };
        }

        case ':': {
          // Begin editing line count (only if not already doing so)
          if (!state.isEditingLineCount) {
            state = { ...state, isEditingLineCount: true, lineCountInput: '' };
            onStateChange();
            return { type: 'consume' };
          }
          // Already editing — treat ':' as a printable filter char fallthrough
          return { type: 'update', buffer: buffer + data };
        }

        default: {
          // Digit while editing line count
          if (state.isEditingLineCount && data >= '0' && data <= '9') {
            const newInput = state.lineCountInput + data;
            const parsed = parseInt(newInput, 10);
            const newLineCount = isNaN(parsed) ? 500 : parsed;
            state = {
              ...state,
              lineCountInput: newInput,
              lineCount: newLineCount,
            };
            onStateChange();
            return { type: 'consume' };
          }

          // Printable character — update filter buffer
          const isPrintable = data.length === 1 && data >= ' ';
          if (isPrintable) {
            const newBuffer = buffer + data;
            updateFiltered(newBuffer);
            // Auto-cancel when filter matches zero terminals (only after terminals loaded).
            // This makes normal @ usage transparent: typing "git@github.com" auto-cancels
            // on "g" since no terminal title matches, flushing "@g" back to PTY.
            if (terminalsLoaded && filteredTerminals.length === 0) {
              return { type: 'cancel' };
            }
            return { type: 'update', buffer: newBuffer };
          }

          // Non-printable, non-handled escape sequence — consume silently
          return { type: 'consume' };
        }
      }
    },

    onDeactivate(): void {
      state = createDefaultState();
      filteredTerminals = [];
      currentFilter = '';
      terminalsLoaded = false;
    },

    getState(): AtTerminalHandlerState {
      return {
        ...state,
        terminals: filteredTerminals,
      };
    },
  };
}
