import type { AgentState } from '../../../shared/types/agentStatus';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';

export interface WorkspaceIdleCandidate {
  panelId: string;
  paneId: string;
  paneName: string;
  panelTitle?: string;
  agentType: string;
  repoId?: number;
  repoName?: string;
  worktreePath?: string;
  agentState: AgentState;
  idleSinceMs: number;
  heldInputPresent?: boolean;
}

export function dueIdleEntries(
  candidates: readonly WorkspaceIdleCandidate[],
  idleAfterMs: number,
  fromMs: number,
  toMs: number,
  generation: number,
): RunpaneWorkspaceEntry[] {
  if (idleAfterMs <= 0 || toMs < fromMs) return [];

  const at = new Date(toMs).toISOString();
  return candidates.flatMap((candidate) => {
    if (candidate.agentState !== 'idle') return [];
    const fromIdleMs = Math.max(0, fromMs - candidate.idleSinceMs);
    const toIdleMs = Math.max(0, toMs - candidate.idleSinceMs);
    const previousCount = Math.floor(fromIdleMs / idleAfterMs);
    const idleCount = Math.floor(toIdleMs / idleAfterMs);
    if (idleCount < 1 || idleCount <= previousCount) return [];

    return [{
      gen: generation,
      at,
      kind: 'agent.idle' as const,
      paneId: candidate.paneId,
      paneName: candidate.paneName,
      repoId: candidate.repoId,
      repoName: candidate.repoName,
      worktreePath: candidate.worktreePath,
      panelId: candidate.panelId,
      panelTitle: candidate.panelTitle,
      agentType: candidate.agentType,
      to: 'idle' as const,
      source: 'agent' as const,
      idleMs: idleCount * idleAfterMs,
      idleCount,
      heldInputPresent: candidate.heldInputPresent,
    }];
  });
}

export function nextIdleDeadline(
  candidates: readonly WorkspaceIdleCandidate[],
  idleAfterMs: number,
  nowMs: number,
): number | undefined {
  if (idleAfterMs <= 0 || candidates.length === 0) return undefined;
  const deadlines = candidates
    .filter(candidate => candidate.agentState === 'idle')
    .map((candidate) => {
      const elapsed = Math.max(0, nowMs - candidate.idleSinceMs);
      return candidate.idleSinceMs + (Math.floor(elapsed / idleAfterMs) + 1) * idleAfterMs;
    });
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}
