import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { panelManager } from '../services/panelManager';
import {
  boundSanitizedLines,
  selectPanelScreenText,
} from '../services/panels/terminalScreenText';
import {
  DEFAULT_MISSION_CONTROL_SNAPSHOT_LINES,
  MAX_MISSION_CONTROL_SNAPSHOT_LINES,
  MAX_MISSION_CONTROL_SNAPSHOT_PANELS,
  MISSION_CONTROL_VIEWER_PREFIX,
  type MissionControlAgentPanel,
  type MissionControlAgentType,
  type MissionControlSnapshot,
  type MissionControlSnapshotRequest,
  type MissionControlSnapshotResult,
} from '../../../shared/types/missionControl';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';

const DAEMON_MISSION_CONTROL_CHANNELS = [
  'mission-control:list-agents',
  'mission-control:snapshots',
] as const;

/**
 * Stale Mission Control viewers are swept on this cadence. Without it, a hard renderer
 * kill would leave every hovered panel pinned "visible" forever, defeating the
 * background output throttling in `terminalPanelManager`.
 */
const VIEWER_PRUNE_INTERVAL_MS = 60_000;
const VIEWER_STALE_AFTER_MS = 180_000;

interface AgentPanelRow {
  id: string;
  session_id: string;
  title: string | null;
  agent_type: string | null;
  session_name: string | null;
  archived: number | null;
  worktree_path: string | null;
  worktree_name: string | null;
  active_panel_id: string | null;
  project_id: number | null;
  project_name: string | null;
}

/**
 * Pane Chat keeps one panel per agent — switching from Claude to Codex leaves
 * the previous one in place — but only ever shows the active one. Listing both
 * in Mission Control showed two chats where the user has one.
 */
function isRedundantPaneChatPanel(row: AgentPanelRow): boolean {
  return row.session_id === PANE_CHAT_SESSION_ID && row.id !== row.active_panel_id;
}

function toAgentType(value: string | null): MissionControlAgentType | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

export function registerMissionControlHandlers(
  ipcMain: IpcMain,
  { databaseService }: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const pruneTimer = setInterval(() => {
    terminalPanelManager.pruneVisibilityViewersByPrefix(MISSION_CONTROL_VIEWER_PREFIX, VIEWER_STALE_AFTER_MS);
  }, VIEWER_PRUNE_INTERVAL_MS);
  // Never hold the process open just to sweep viewers.
  pruneTimer.unref?.();

  /**
   * Every agent pane across every session.
   *
   * Deliberately a narrow SQL projection rather than `getAllPanels()` — that
   * deserialises each panel's `state` JSON, which carries the full scrollback
   * buffer and can be tens of megabytes on a large install.
   */
  commandRegistry.register('mission-control:list-agents', async (options?: { includeArchived?: boolean }) => {
    try {
      // SAFETY: The SELECT list below names exactly the columns AgentPanelRow declares.
      const rows = databaseService.getDb().prepare(`
        SELECT
          tp.id,
          tp.session_id,
          tp.title,
          json_extract(tp.state, '$.customState.agentType') AS agent_type,
          s.name    AS session_name,
          s.archived,
          s.worktree_path,
          s.worktree_name,
          s.active_panel_id,
          s.project_id,
          p.name    AS project_name
        FROM tool_panels tp
        JOIN sessions s ON s.id = tp.session_id
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE tp.type = 'terminal'
          AND json_extract(tp.state, '$.customState.isCliPanel') = 1
        ORDER BY p.name, s.name, tp.created_at
      `).all() as AgentPanelRow[];

      const includeArchived = options?.includeArchived === true;

      const agents: MissionControlAgentPanel[] = rows
        .filter(row => (includeArchived || !row.archived) && !isRedundantPaneChatPanel(row))
        .map(row => ({
          panelId: row.id,
          sessionId: row.session_id,
          sessionName: row.session_name ?? 'Untitled session',
          projectId: row.project_id,
          // Pane Chat has no project; naming its group after itself beats
          // filing it under "Unknown project".
          projectName: row.project_name
            ?? (row.session_id === PANE_CHAT_SESSION_ID ? 'Pane Chat' : 'Unknown project'),
          worktreePath: row.worktree_path,
          worktreeName: row.worktree_name,
          panelTitle: row.title ?? 'Terminal',
          agentType: toAgentType(row.agent_type),
          isLive: terminalPanelManager.isTerminalInitialized(row.id),
        }));

      return { success: true, data: agents };
    } catch (error) {
      console.error('[MissionControl] Failed to list agent panels:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agent panels',
      };
    }
  });

  /**
   * Plain-text screen snapshots for a batch of panels.
   *
   * Snapshots are taken sequentially: each one awaits emulator idle, and doing
   * 30+ of those in parallel spikes the main process.
   */
  commandRegistry.register('mission-control:snapshots', async (request: MissionControlSnapshotRequest) => {
    try {
      const requestedIds = Array.isArray(request?.panelIds) ? request.panelIds : [];
      const panelIds = requestedIds.slice(0, MAX_MISSION_CONTROL_SNAPSHOT_PANELS);
      const maxLines = Math.min(
        Math.max(Number(request?.maxLines) || DEFAULT_MISSION_CONTROL_SNAPSHOT_LINES, 1),
        MAX_MISSION_CONTROL_SNAPSHOT_LINES
      );

      const snapshots: MissionControlSnapshot[] = [];

      // Waiting for emulator idle is a wait, not work, so every panel waits at
      // once: one busy agent would otherwise delay every later tile in the batch
      // and push the whole poll past its interval. The extraction below stays
      // sequential, because that part is CPU.
      await Promise.all(panelIds.map(panelId => terminalPanelManager.waitForTerminalState(panelId)));

      for (const panelId of panelIds) {
        const panel = panelManager.getPanel(panelId);
        // A panel that no longer exists simply has no tile: the client replaces
        // its whole snapshot map each poll, so a dropped id drops itself.
        if (!panel) continue;

        const liveSnapshot = terminalPanelManager.getTerminalSnapshot(panelId);
        // SAFETY: Panel state is written by terminalPanelManager for terminal panels; an absent value falls back to {}.
        const customState = (panel.state.customState ?? {}) as TerminalPanelState;
        const { rawText } = selectPanelScreenText(liveSnapshot, customState);
        const bounded = boundSanitizedLines(rawText, maxLines);

        snapshots.push({
          panelId,
          text: bounded.text,
          isAlternateScreen: liveSnapshot?.isAlternateScreen ?? Boolean(customState.isAlternateScreen),
          lastActivityAt: liveSnapshot?.lastActivityTime ?? customState.lastActivityTime ?? null,
          cols: liveSnapshot?.cols ?? customState.dimensions?.cols ?? null,
          rows: liveSnapshot?.rows ?? customState.dimensions?.rows ?? null,
        });
      }

      const result: MissionControlSnapshotResult = {
        snapshots,
        capturedAt: new Date().toISOString(),
      };
      return { success: true, data: result };
    } catch (error) {
      console.error('[MissionControl] Failed to capture snapshots:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture snapshots',
      };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_MISSION_CONTROL_CHANNELS);
}
