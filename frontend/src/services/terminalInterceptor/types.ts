/** Result of feeding input data to the interceptor */
export interface InterceptResult {
  consumed: boolean; // true = interceptor handled it, don't send to PTY
}

/** State exposed by the interceptor for UI rendering */
export interface InterceptorState {
  active: boolean;
  triggerChar: string | null;
  buffer: string; // characters typed after trigger (for filtering)
  // Handler-specific UI state passed opaquely
  handlerState: unknown;
}

/** A pluggable handler for a trigger character */
export interface InterceptHandler {
  /** Called when the trigger character is typed. Return false to pass through (e.g., no other terminals). */
  onActivate: () => boolean;
  /** Called for each subsequent keystroke while active. Returns action to take. */
  onInput: (data: string, buffer: string) => InterceptAction;
  /** Clean up when deactivating */
  onDeactivate: () => void;
  /** Get current handler-specific state for UI rendering */
  getState: () => unknown;
}

/** Actions a handler can return from onInput */
export type InterceptAction =
  | { type: 'consume' } // eat the keystroke, stay active
  | { type: 'cancel' } // cancel interception, flush buffer
  | { type: 'execute'; payload: InterceptPayload } // execute action, deactivate
  | { type: 'update'; buffer: string }; // update filter buffer, stay active

/** Payload when executing an action */
export interface InterceptPayload {
  action: string;
  data: Record<string, unknown>;
}

/** State specific to the @ terminal handler */
export interface AtTerminalHandlerState {
  terminals: TerminalSuggestion[];
  selectedIndex: number;
  lineCount: number; // default 500
  lineCountInput: string; // raw input after ':'
  isEditingLineCount: boolean;
}

/** A terminal suggestion in the dropdown */
export interface TerminalSuggestion {
  panelId: string;
  title: string;
  preview: string[]; // last 5 lines, ANSI-stripped
}
