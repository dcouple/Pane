import type { ProjectEnvironment, ToolPanelType } from './panels';
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

export interface RunpaneDoctorResult {
  ok: true;
  app: {
    version: string;
    isPackaged: boolean;
    platform: string;
    electronVersion?: string;
    nodeVersion?: string;
  };
  daemon: {
    channels: string[];
  };
  repos: {
    count: number;
    active?: RunpaneRepoSummary;
  };
  agentContext: {
    recommendedFirstCommands: string[];
  };
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
  waitReady?: boolean;
  readyTimeoutMs?: number;
  concurrency?: number;
}

export interface RunpaneErrorPayload {
  message: string;
  code?: string;
}

export type RunpanePanelActivityStatus = 'active' | 'idle';
export type RunpanePanelScreenSource = 'alternateScreen' | 'scrollback' | 'persistedOutput' | 'empty';
export type RunpanePanelWaitCondition = 'initialized' | 'ready' | 'idle' | 'text';
export type RunpanePanelBlockerKind = 'codex-update' | 'agent-prompt' | 'unknown';

export interface RunpanePanelStateSummary {
  initialized: boolean;
  isAlternateScreen?: boolean;
  activityStatus?: RunpanePanelActivityStatus;
  isCliReady?: boolean;
  isCliPanel?: boolean;
  agentType?: RunpaneAgentId;
  lastActivity?: string;
}

export interface RunpanePanelBlockedState {
  kind: RunpanePanelBlockerKind;
  message: string;
  suggestedCommand?: string;
}

export interface RunpanePaneReadiness {
  ok: boolean;
  condition: RunpanePanelWaitCondition;
  matched: boolean;
  timedOut: boolean;
  elapsedMs: number;
  state: RunpanePanelStateSummary;
  blocked?: RunpanePanelBlockedState;
  nextCommand?: string;
}

export interface RunpanePaneCreateSuccessItem {
  ok: true;
  index: number;
  name: string;
  sessionId?: string;
  paneId?: string;
  panelId?: string;
  worktreePath?: string;
  nextCommand?: string;
  tool?: {
    title: string;
    command: string;
    agent?: RunpaneAgentId;
  };
  readiness?: RunpanePaneReadiness;
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

export interface RunpanePaneSummary {
  id: string;
  paneId: string;
  name: string;
  status: string;
  worktreePath: string;
  repoId: number;
  repoName?: string;
  panelCount: number;
  createdAt?: string;
  lastActivity?: string;
  archived?: boolean;
}

export interface RunpanePaneListRequest {
  repo?: RunpaneRepoSelector;
}

export interface RunpanePaneListResult {
  ok: true;
  repo?: RunpaneRepoSummary;
  panes: RunpanePaneSummary[];
}

export interface RunpanePanelSummary {
  id: string;
  panelId: string;
  paneId: string;
  type: ToolPanelType;
  title: string;
  active: boolean;
  initialized?: boolean;
  agentType?: RunpaneAgentId;
  isCliPanel?: boolean;
  position?: number;
  createdAt?: string;
  lastActiveAt?: string;
}

export interface RunpanePanelListRequest {
  paneId: string;
}

export interface RunpanePanelListResult {
  ok: true;
  paneId: string;
  panels: RunpanePanelSummary[];
}

export interface RunpanePanelOutputRecord {
  type: string;
  data: unknown;
  timestamp: string;
}

export interface RunpanePanelOutputRequest {
  panelId: string;
  limit?: number;
}

export interface RunpanePanelOutputResult {
  ok: true;
  panelId: string;
  paneId?: string;
  limit: number;
  returnedCount: number;
  hasMore: boolean;
  outputs: RunpanePanelOutputRecord[];
  text: string;
}

export interface RunpanePanelScreenRequest {
  panelId: string;
  limit?: number;
}

export interface RunpanePanelScreenResult {
  ok: true;
  panelId: string;
  paneId?: string;
  source: RunpanePanelScreenSource;
  limit: number;
  returnedLineCount: number;
  hasMore: boolean;
  text: string;
  state: RunpanePanelStateSummary;
  nextCommand?: string;
}

export interface RunpanePanelInputRequest {
  panelId: string;
  input: string;
}

export interface RunpanePanelInputResult {
  ok: true;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  sentAt: string;
  nextCommand?: string;
}

export interface RunpanePanelSubmitRequest {
  panelId: string;
  input: string;
}

export interface RunpanePanelSubmitResult {
  ok: true;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  enter: 'cr';
  sentAt: string;
  nextCommand?: string;
}

export interface RunpanePanelWaitRequest {
  panelId: string;
  condition?: RunpanePanelWaitCondition;
  contains?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface RunpanePanelWaitResult {
  ok: boolean;
  panelId: string;
  paneId?: string;
  condition: RunpanePanelWaitCondition;
  matched: boolean;
  timedOut: boolean;
  elapsedMs: number;
  state: RunpanePanelStateSummary;
  blocked?: RunpanePanelBlockedState;
  screen: Pick<RunpanePanelScreenResult, 'source' | 'text' | 'hasMore'>;
  nextCommand?: string;
}

export interface RunpaneAgentDoctorRequest {
  agent: RunpaneAgentId;
  repo?: RunpaneRepoSelector;
}

export interface RunpaneAgentDoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface RunpaneAgentDoctorResult {
  ok: boolean;
  agent: RunpaneAgentId;
  command: string;
  repo?: RunpaneRepoSummary;
  environment?: ProjectEnvironment;
  available: boolean;
  executablePath?: string;
  version?: string;
  checks: RunpaneAgentDoctorCheck[];
  warnings?: string[];
}

export interface RunpaneResolvedTool {
  title: string;
  command: string;
  agent?: RunpaneAgentId;
  initialInput?: string;
}
