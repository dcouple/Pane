import type {
  AtTerminalHandlerState,
  InterceptAction,
  InterceptHandler,
  TerminalSuggestion,
} from '../types';
import { LINE_COUNT_PRESETS } from '../types';

interface AtTerminalHandlerOptions {
  sessionId: string;
  currentPanelId: string;
  getTerminals: () => Promise<TerminalSuggestion[]>;
  hasOtherTerminals: () => boolean; // fast sync check
  onCopy: (panelId: string, lines: number) => Promise<void>;
  onStateChange: () => void; // notify interceptor to re-render
}

const DEFAULT_PRESET_INDEX = 2; // 500 lines

function createDefaultState(): AtTerminalHandlerState {
  return {
    terminals: [],
    selectedIndex: 0,
    lineCountPresetIndex: DEFAULT_PRESET_INDEX,
    lineCount: LINE_COUNT_PRESETS[DEFAULT_PRESET_INDEX],
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
          // Arrow up — navigate terminal list
          const newIndex = Math.max(0, state.selectedIndex - 1);
          state = { ...state, selectedIndex: newIndex };
          onStateChange();
          return { type: 'consume' };
        }

        case '\x1b[B': {
          // Arrow down — navigate terminal list
          const maxIndex = Math.max(0, filteredTerminals.length - 1);
          const newIndexDown = Math.min(maxIndex, state.selectedIndex + 1);
          state = { ...state, selectedIndex: newIndexDown };
          onStateChange();
          return { type: 'consume' };
        }

        case '\x1b[D': {
          // Arrow left — decrease line count preset
          const newPresetIndex = Math.max(0, state.lineCountPresetIndex - 1);
          state = {
            ...state,
            lineCountPresetIndex: newPresetIndex,
            lineCount: LINE_COUNT_PRESETS[newPresetIndex],
          };
          onStateChange();
          return { type: 'consume' };
        }

        case '\x1b[C': {
          // Arrow right — increase line count preset
          const newPresetIndex = Math.min(
            LINE_COUNT_PRESETS.length - 1,
            state.lineCountPresetIndex + 1,
          );
          state = {
            ...state,
            lineCountPresetIndex: newPresetIndex,
            lineCount: LINE_COUNT_PRESETS[newPresetIndex],
          };
          onStateChange();
          return { type: 'consume' };
        }

        case '\r': {
          // Enter — execute copy on selected terminal
          const selected = filteredTerminals[state.selectedIndex];
          if (selected !== undefined) {
            // -1 means "All" — pass a very large number
            const lines = state.lineCount === -1 ? 999999 : state.lineCount;
            onCopy(selected.panelId, lines).catch(() => {
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
          if (buffer.length > 0) {
            // Remove last char from filter
            const newBuffer = buffer.slice(0, -1);
            updateFiltered(newBuffer);
            return { type: 'update', buffer: newBuffer };
          }
          // Backspace on empty filter — cancel
          return { type: 'cancel' };
        }

        default: {
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
