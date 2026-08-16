import type { ToolPanel } from './panels';

export type PaneChatAgent = 'claude' | 'codex' | 'cursor';

export const DEFAULT_PANE_CHAT_AGENT: PaneChatAgent = 'claude';
export const PANE_CHAT_SESSION_ID = '__pane_chat_session__';
export const PANE_CHAT_PANEL_ID = '__pane_chat_terminal__';
export const PANE_CHAT_CODEX_PANEL_ID = '__pane_chat_terminal_codex__';
export const PANE_CHAT_CURSOR_PANEL_ID = '__pane_chat_terminal_cursor__';

const PANE_CHAT_PANEL_IDS: Record<PaneChatAgent, string> = {
  claude: PANE_CHAT_PANEL_ID,
  codex: PANE_CHAT_CODEX_PANEL_ID,
  cursor: PANE_CHAT_CURSOR_PANEL_ID,
};

export interface PaneChatState<TSession = unknown> {
  session: TSession;
  panel: ToolPanel;
  agent: PaneChatAgent;
  cwd: string;
  guidePath: string;
  started: boolean;
}

export function normalizePaneChatAgent(value: unknown): PaneChatAgent {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PANE_CHAT_PANEL_IDS, value)
    ? (value as PaneChatAgent)
    : DEFAULT_PANE_CHAT_AGENT;
}

export function getPaneChatPanelId(agent: PaneChatAgent): string {
  return PANE_CHAT_PANEL_IDS[agent];
}
