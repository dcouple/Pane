import type { ProjectEnvironment } from './panels';
import type { RunpaneAgent } from './generatedRunpaneContract';

export type RunpaneAgentId = RunpaneAgent;

export type RunpaneRepoSelector =
  | string
  | { id: number }
  | { path: string }
  | { name: string }
  | { active: true };

export interface RunpaneRepoSummary {
  id: number;
  name: string;
  path: string;
  active: boolean;
  environment?: ProjectEnvironment;
  sessionCount: number;
}

export interface RunpaneRepoListResult {
  ok: true;
  repos: RunpaneRepoSummary[];
}

export interface RunpaneRepoAddRequest {
  path: string;
  name?: string;
  dryRun?: boolean;
}

export interface RunpaneRepoAddPreview {
  name: string;
  path: string;
  alreadyExists: boolean;
  wouldCreate: boolean;
  environment?: ProjectEnvironment;
}

export interface RunpaneRepoAddResult {
  ok: true;
  created: boolean;
  dryRun?: boolean;
  repo?: RunpaneRepoSummary;
  preview?: RunpaneRepoAddPreview;
}

export interface RunpaneAgentToolSpec {
  agent: RunpaneAgentId;
  title?: string;
  initialInput?: string;
}

export interface RunpaneCommandToolSpec {
  command: string;
  title?: string;
  initialInput?: string;
}

export type RunpaneToolSpec = RunpaneAgentToolSpec | RunpaneCommandToolSpec;

export interface RunpanePaneCreateItem {
  name: string;
  worktreeName?: string;
  baseBranch?: string;
  sessionPrompt?: string;
  tool: RunpaneToolSpec;
}

export interface RunpanePaneCreateRequest {
  repo: RunpaneRepoSelector;
  panes: RunpanePaneCreateItem[];
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface RunpaneErrorPayload {
  message: string;
  code?: string;
}

export interface RunpanePaneCreateSuccessItem {
  ok: true;
  index: number;
  name: string;
  sessionId?: string;
  paneId?: string;
  panelId?: string;
  worktreePath?: string;
  tool?: {
    title: string;
    command: string;
    agent?: RunpaneAgentId;
  };
}

export interface RunpanePaneCreateFailureItem {
  ok: false;
  index: number;
  name?: string;
  error: RunpaneErrorPayload;
}

export type RunpanePaneCreateResultItem =
  | RunpanePaneCreateSuccessItem
  | RunpanePaneCreateFailureItem;

export interface RunpanePaneCreateResult {
  ok: boolean;
  repo: RunpaneRepoSummary;
  items: RunpanePaneCreateResultItem[];
}

export interface RunpaneResolvedTool {
  title: string;
  command: string;
  agent?: RunpaneAgentId;
  initialInput?: string;
}
