import type { SessionManager } from './sessionManager';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { AgentState } from '../../../shared/types/agentStatus';
import type {
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
  RunpaneWorkspacePanelSummary,
  RunpaneWorkspaceStateResult,
} from '../../../shared/types/runpaneOrchestration';

export class WorkspaceStateReader {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly getEpoch: () => string,
    private readonly getGeneration: () => number,
  ) {}

  read(repoId?: number): RunpaneWorkspaceStateResult {
    const at = new Date().toISOString();
    const generation = this.getGeneration();
    const entries: RunpaneWorkspaceEntry[] = [];
    const sessions = repoId === undefined
      ? this.sessionManager.getAllSessions()
      : this.sessionManager.getSessionsForProject(repoId);

    for (const session of sessions) {
      if (session.archived || session.isHidden) continue;
      const project = this.sessionManager.getProjectForSession(session.id);
      const common = {
        gen: generation,
        at,
        paneId: session.id,
        paneName: session.name,
        repoId: project?.id,
        repoName: project?.name,
        worktreePath: session.worktreePath,
        baseline: true as const,
      };

      const panelSummaries: RunpaneWorkspacePanelSummary[] = [];
      const agentEntries: RunpaneWorkspaceEntry[] = [];

      for (const panel of panelManager.getPanelsForSession(session.id)) {
        if (panel.type !== 'terminal') continue;
        const customState = decodeBoundary(panel.state.customState ?? {}, boundary.object({
          isCliPanel: boundary.optional(boundary.boolean),
          agentType: boundary.optional(boundary.string),
        }));
        const agentState = resolveAgentState(panel.id);
        panelSummaries.push({
          panelId: panel.id,
          title: panel.title,
          agentType: customState.agentType,
          agentState,
        });

        if (customState?.isCliPanel !== true) continue;
        agentEntries.push({
          ...common,
          kind: entryKindForState(agentState),
          panelId: panel.id,
          panelTitle: panel.title,
          agentType: customState.agentType,
          to: agentState,
          source: 'agent',
        });
      }

      entries.push({ ...common, kind: 'pane.created', source: 'session', panels: panelSummaries });
      entries.push(...agentEntries);
    }

    return { ok: true, epoch: this.getEpoch(), generation, entries };
  }
}

function resolveAgentState(panelId: string): AgentState {
  const tracked = terminalPanelManager.getAgentStatus(panelId);
  if (tracked) return tracked;
  const initialized = terminalPanelManager.isTerminalInitialized(panelId);
  return initialized ? 'unknown' : 'idle';
}

function entryKindForState(state: AgentState): RunpaneWorkspaceEntryKind {
  if (state === 'working') return 'agent.busy';
  if (state === 'blocked') return 'agent.blocked';
  if (state === 'idle') return 'agent.ready';
  return 'agent.unknown';
}
