import type {
  RunpaneAgentId,
  RunpanePanelBlockedState,
} from '../../../shared/types/runpaneOrchestration';
import { sanitizeTerminalOutput } from '../utils/terminalOutputSanitizer';

export function boundSanitizedLines(
  rawText: string,
  limit: number,
): { text: string; hasMore: boolean; returnedLineCount: number } {
  const stripped = sanitizeTerminalOutput(rawText);
  if (!stripped) return { text: '', hasMore: false, returnedLineCount: 0 };
  const allLines = stripped.split('\n');
  const hasMore = allLines.length > limit;
  const lines = hasMore ? allLines.slice(-limit) : allLines;
  return { text: lines.join('\n'), hasMore, returnedLineCount: lines.length };
}

export function detectPanelBlocker(
  text: string,
  agentType: RunpaneAgentId | undefined,
  panelId: string,
): RunpanePanelBlockedState | undefined {
  if (!text) return undefined;
  if (
    (agentType === 'codex' || /codex/i.test(text)) &&
    /update available/i.test(text) &&
    (/skip/i.test(text) || /npm install -g @openai\/codex/i.test(text))
  ) {
    return {
      kind: 'codex-update',
      message: 'Codex is showing an update prompt instead of accepting the task prompt.',
      suggestedCommand: `runpane panels submit --panel ${panelId} --text "2" --yes --json`,
    };
  }
  if (/press enter to continue/i.test(text)) {
    return {
      kind: 'agent-prompt',
      message: 'The terminal is waiting at an interactive prompt.',
      suggestedCommand: `runpane panels screen --panel ${panelId} --json`,
    };
  }
  return undefined;
}
