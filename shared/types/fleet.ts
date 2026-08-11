import type { AgentState } from './agentStatus';

/**
 * Types for the fleet grid — a live overview of every agent pane across all
 * sessions and projects at once.
 *
 * An "agent" here is a terminal panel with `customState.isCliPanel === true`;
 * Pane has no dedicated agent panel type.
 */

export type FleetAgentType = 'claude' | 'codex';

export interface FleetAgentPanel {
  panelId: string;
  sessionId: string;
  sessionName: string;
  sessionArchived: boolean;
  projectId: number | null;
  projectName: string;
  /** Absolute worktree path, used for the "by worktree" grouping. */
  worktreePath: string | null;
  /** Worktree/branch name — often the session's real identity in a project. */
  worktreeName: string | null;
  panelTitle: string;
  agentType: FleetAgentType | null;
  /** True when a PTY for this panel is alive in the main process right now. */
  isLive: boolean;
}

export interface FleetSnapshot {
  panelId: string;
  /** ANSI-stripped text, at most `maxLines` trailing lines. */
  text: string;
  lineCount: number;
  isAlternateScreen: boolean;
  /** false when the panel has no live PTY and the text came from storage. */
  isLive: boolean;
  lastActivityAt: string | null;
  /**
   * Live PTY dimensions, when the terminal is running. A live tile must size
   * its terminal to exactly these — agent TUIs use absolute cursor
   * positioning, so a mismatched width wraps every line and scrolls forever.
   */
  cols: number | null;
  rows: number | null;
}

export interface FleetSnapshotRequest {
  panelIds: string[];
  /** Trailing lines per tile. Defaults to 16. */
  maxLines?: number;
}

export interface FleetSnapshotResult {
  snapshots: FleetSnapshot[];
  /** Requested ids that no longer exist — the client should drop these tiles. */
  missing: string[];
  capturedAt: string;
}

/**
 * Snapshotting N emulators is sequential and each one awaits emulator idle, so
 * the batch is capped to keep a single poll well under the refresh interval.
 */
export const MAX_FLEET_SNAPSHOT_PANELS = 64;
export const MAX_FLEET_SNAPSHOT_LINES = 120;
export const DEFAULT_FLEET_SNAPSHOT_LINES = 16;

// --- Client-side view options ---

export type FleetGrouping = 'project' | 'status' | 'agent' | 'none';
/** Tiles per row. Lower density = larger tiles with more visible lines. */
export type FleetDensity = 1 | 2 | 3 | 4;

export interface FleetTileModel extends FleetAgentPanel {
  agentState: AgentState;
  snapshot: FleetSnapshot | null;
}

export interface FleetGroup {
  key: string;
  label: string;
  tiles: FleetTileModel[];
}
