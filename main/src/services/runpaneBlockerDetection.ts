import type {
  RunpaneAgentId,
  RunpanePanelBlockedState,
} from '../../../shared/types/runpaneOrchestration';
import { sanitizeTerminalOutput } from '../utils/terminalOutputSanitizer';
import { classifyRunpaneInterstitial } from './runpaneInterstitials';

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
  const classification = classifyRunpaneInterstitial(text, agentType, panelId);
  if (classification.disposition === 'allow') {
    return {
      kind: 'codex-update',
      message: 'Codex is showing an update prompt instead of accepting the task prompt.',
      suggestedCommand: `runpane panels submit --panel ${panelId} --text "2" --yes --json`,
    };
  }
  if (classification.disposition === 'deny' || classification.disposition === 'unknown') {
    return {
      kind: 'agent-prompt',
      message: classification.blocker.message,
      suggestedCommand: classification.blocker.suggestedCommand,
    };
  }
  return undefined;
}
