import type { ToolPanel } from './panels';

export type PaneChatAgent = 'claude' | 'codex';

export const DEFAULT_PANE_CHAT_AGENT: PaneChatAgent = 'claude';
export const PANE_CHAT_SESSION_ID = '__pane_chat_session__';
export const PANE_CHAT_PANEL_ID = '__pane_chat_terminal__';

export interface PaneChatState<TSession = unknown> {
  session: TSession;
  panel: ToolPanel;
  agent: PaneChatAgent;
  cwd: string;
  guidePath: string;
  started: boolean;
}

export function normalizePaneChatAgent(value: unknown): PaneChatAgent {
  return value === 'codex' ? 'codex' : DEFAULT_PANE_CHAT_AGENT;
}
