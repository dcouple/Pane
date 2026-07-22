import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import type {
  RunpaneAgentId,
  RunpanePanelBlockedState,
  RunpanePanelStateSummary,
} from '../../../shared/types/runpaneOrchestration';
import { terminalPanelManager, type TerminalPanelSnapshot } from './terminalPanelManager';

const AGENT_IDS = new Set<string>(['claude', 'codex']);

function toIsoString(value: string | number | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function getTerminalCustomState(panel: ToolPanel): TerminalPanelState {
  const value = panel.state.customState;
  return (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as TerminalPanelState;
}

export function panelStateSummary(
  panel: ToolPanel,
  snapshot: TerminalPanelSnapshot | null,
  customState: TerminalPanelState = getTerminalCustomState(panel),
  blocker?: RunpanePanelBlockedState,
): RunpanePanelStateSummary {
  const customAgentType = typeof customState.agentType === 'string' && AGENT_IDS.has(customState.agentType)
    ? customState.agentType as RunpaneAgentId
    : undefined;
  const hasLiveTerminal = Boolean(snapshot || terminalPanelManager.isTerminalInitialized(panel.id));
  return {
    initialized: hasLiveTerminal,
    isAlternateScreen: snapshot?.isAlternateScreen ?? customState.isAlternateScreen,
    activityStatus: snapshot?.activityStatus,
    isCliReady: snapshot?.isCliReady ?? (hasLiveTerminal ? customState.isCliReady : undefined),
    isCliPanel: snapshot?.isCliPanel ?? customState.isCliPanel,
    agentType: snapshot?.agentType ?? customAgentType,
    lastActivity: snapshot?.lastActivityTime ?? customState.lastActivityTime ?? toIsoString(panel.metadata.lastActiveAt),
    terminalReady: snapshot?.terminalReady,
    agentActivity: snapshot?.agentActivity ?? (customState.exitedAt ? 'exited' : 'unknown'),
    inputRequired: blocker?.kind === 'agent-prompt' || blocker?.kind === 'codex-update',
    blocked: blocker !== undefined,
    hasNewOutput: snapshot ? snapshot.outputGeneration > snapshot.outputGenerationAtQuiescence : false,
    outputGeneration: snapshot?.outputGeneration,
    lastMeaningfulEventAt: snapshot?.lastMeaningfulEventAt ?? customState.exitedAt,
  };
}
