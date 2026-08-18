import fs from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { invokeDaemon } from './daemonClient';
import { RUNPANE_CONTRACT } from './generated/contract';
import type { ParsedArgs, RunpaneAgent } from './commands';
import type { BoundarySchema, JsonValue } from './boundaryDecoder';

interface RepoSummary {
  id: number;
  name: string;
  path: string;
  active: boolean;
  environment?: string;
  sessionCount: number;
}

interface RepoListResult {
  ok: true;
  repos: RepoSummary[];
}

interface RepoAddRequest {
  path: string;
  name?: string;
  dryRun?: boolean;
}

interface RepoAddPreview {
  name: string;
  path: string;
  alreadyExists: boolean;
  wouldCreate: boolean;
  environment?: string;
}

interface RepoAddResult {
  ok: true;
  created: boolean;
  dryRun?: boolean;
  repo?: RepoSummary;
  preview?: RepoAddPreview;
}

interface PaneCreateRequest {
  repo: string | { id: number } | { path: string } | { name: string } | { active: true };
  panes: PaneCreateItem[];
  dryRun?: boolean;
  timeoutMs?: number;
  waitReady?: boolean;
  readyTimeoutMs?: number;
  concurrency?: number;
  noFocus?: boolean;
  focus?: boolean;
  source?: 'user' | 'agent';
}

interface PaneCreateItem {
  name: string;
  worktreeName?: string;
  baseBranch?: string;
  sessionPrompt?: string;
  pinned?: boolean;
  tool: PaneToolSpec;
}

type PaneToolSpec =
  | { agent: RunpaneAgent; title?: string; initialInput?: string }
  | { command: string; title?: string; initialInput?: string };

interface PaneCreateSuccessItem {
  ok: true;
  index: number;
  name?: string;
  pinned: boolean;
  sessionId?: string;
  panelId?: string;
  worktreePath?: string;
  nextCommand?: string;
  readiness?: PanelReadiness;
  initialInput?: InitialInputDeliveryResult;
}

interface PaneCreateFailureItem {
  ok: false;
  index: number;
  name?: string;
  error: { message: string; code?: string };
}

interface PaneCreateResult {
  ok: boolean;
  repo: RepoSummary;
  items: Array<PaneCreateSuccessItem | PaneCreateFailureItem>;
}

interface InitialInputDeliveryResult {
  delivered: boolean;
  submitted: boolean;
  inputBytes: number;
  strategy?: 'codex-ctrl-enter' | 'enter' | 'argument';
  sequenceName?: 'codex-ctrl-enter-cr' | 'enter-cr' | 'argument';
  verifiedSubmitted?: boolean;
  staged?: boolean;
  attempts?: number;
  sentAt?: string;
  blocked?: PanelBlockedState;
  error?: { message: string; code?: string };
  nextCommand?: string;
}

interface PaneSummary {
  id: string;
  paneId: string;
  name: string;
  status: string;
  worktreePath: string;
  repoId: number;
  repoName?: string;
  panelCount: number;
  pinned: boolean;
  createdAt?: string;
  lastActivity?: string;
  archived?: boolean;
}

interface PaneListResult {
  ok: true;
  repo?: RepoSummary;
  panes: PaneSummary[];
}

interface PaneArchiveRequest {
  paneId: string;
  force?: boolean;
  source?: 'user' | 'agent';
}

interface PanePinRequest {
  paneId: string;
  pinned: boolean;
  dryRun?: boolean;
}

interface PanePinResult {
  ok: true;
  paneId: string;
  pinned: boolean;
  dryRun?: true;
  favoritePinnedAt?: string;
}

interface PaneRenameRequest {
  paneId: string;
  name: string;
  dryRun?: boolean;
}

interface PaneRenameResult {
  ok: true;
  dryRun?: true;
  pane: PaneSummary;
}

interface PaneArchiveSafetyCheck {
  performed: boolean;
  hasUncommittedChanges?: boolean;
  hasUntrackedFiles?: boolean;
  hasUpstream?: boolean;
  unpushedCommits?: number;
}

interface PaneArchiveBlockedResult {
  ok: false;
  paneId: string;
  blocked: {
    code: 'uncommitted-changes' | 'unpushed-commits' | 'uncommitted-and-unpushed' | 'status-unknown';
    message: string;
    safetyCheck: PaneArchiveSafetyCheck;
  };
  nextCommand: string;
}

interface PaneArchiveSuccessResult {
  ok: boolean;
  paneId: string;
  archived: true;
  forced: boolean;
  worktreeCleanup: 'completed' | 'failed' | 'timeout' | 'not-applicable';
  worktreePath?: string;
  safetyCheck: PaneArchiveSafetyCheck;
}

type PaneArchiveResult = PaneArchiveSuccessResult | PaneArchiveBlockedResult;

interface PanelSummary {
  id: string;
  panelId: string;
  paneId: string;
  type: string;
  title: string;
  active: boolean;
  initialized?: boolean;
  agentType?: string;
  isCliPanel?: boolean;
  position?: number;
  createdAt?: string;
  lastActiveAt?: string;
}

interface PanelListResult {
  ok: true;
  paneId: string;
  panels: PanelSummary[];
}

interface PanelCreateRequest {
  paneId: string;
  type?: 'terminal';
  tool: PaneToolSpec;
  noFocus?: boolean;
  focus?: boolean;
  source?: 'user' | 'agent';
  waitReady?: boolean;
  readyTimeoutMs?: number;
}

interface PanelCreateResult {
  ok: boolean;
  paneId: string;
  panelId: string;
  title: string;
  active: boolean;
  focused: boolean;
  tool: {
    title: string;
    command: string;
    agent?: RunpaneAgent;
  };
  readiness?: PanelReadiness;
  initialInput?: InitialInputDeliveryResult;
  nextCommand?: string;
}

interface PanelOutputRecord {
  type: string;
  data: JsonValue;
  timestamp: string;
}

interface PanelOutputResult {
  ok: true;
  panelId: string;
  paneId?: string;
  limit: number;
  returnedCount: number;
  hasMore: boolean;
  outputs: PanelOutputRecord[];
  text: string;
}

interface PanelInputRequest {
  panelId: string;
  input: string;
}

interface PanelInputResult {
  ok: true;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  sentAt: string;
  nextCommand?: string;
}

interface PanelStateSummary {
  initialized: boolean;
  isAlternateScreen?: boolean;
  activityStatus?: 'active' | 'idle';
  isCliReady?: boolean;
  isCliPanel?: boolean;
  agentType?: RunpaneAgent;
  lastActivity?: string;
}

interface PanelBlockedState {
  kind: 'codex-update' | 'agent-prompt' | 'submission_unverified' | 'unknown';
  message: string;
  suggestedCommand?: string;
}

interface PanelReadiness {
  ok: boolean;
  condition: string;
  matched: boolean;
  timedOut: boolean;
  elapsedMs: number;
  state: PanelStateSummary;
  blocked?: PanelBlockedState;
  nextCommand?: string;
}

interface PanelScreenResult {
  ok: true;
  panelId: string;
  paneId?: string;
  source: 'alternateScreen' | 'scrollback' | 'persistedOutput' | 'empty';
  limit: number;
  returnedLineCount: number;
  hasMore: boolean;
  text: string;
  state: PanelStateSummary;
  nextCommand?: string;
}

interface PanelSubmitResult {
  ok: true;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  enter: 'cr';
  sentAt: string;
  nextCommand?: string;
}

interface PanelSubmitComposerResult {
  ok: boolean;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  strategy: 'codex-ctrl-enter' | 'enter';
  sequenceName: 'codex-ctrl-enter-cr' | 'enter-cr';
  verifiedSubmitted: boolean;
  sentAt: string;
  blocked?: PanelBlockedState;
  nextCommand?: string;
}

interface PanelWaitResult extends PanelReadiness {
  panelId: string;
  paneId?: string;
  screen: {
    source: PanelScreenResult['source'];
    text: string;
    hasMore: boolean;
  };
}

interface AgentDoctorResult {
  ok: boolean;
  agent: RunpaneAgent;
  command: string;
  repo?: RepoSummary;
  environment?: string;
  available: boolean;
  executablePath?: string;
  version?: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
  }>;
  warnings?: string[];
}

interface PaneToolInput {
  agent?: string;
  command?: string;
  title?: string;
  initialInput?: string;
}

interface PaneCreateItemInput {
  name: string;
  worktreeName?: string;
  baseBranch?: string;
  sessionPrompt?: string;
  pinned?: boolean;
  tool: PaneToolInput;
}

interface PaneCreateRequestInput {
  repo: PaneCreateRequest['repo'];
  panes: PaneCreateItemInput[];
  dryRun?: boolean;
  timeoutMs?: number;
  waitReady?: boolean;
  readyTimeoutMs?: number;
  concurrency?: number;
  noFocus?: boolean;
  focus?: boolean;
  source?: 'user' | 'agent';
}

const agentSchema = boundary.enumeration(...RUNPANE_CONTRACT.enums.agents);
const repoSummarySchema: BoundarySchema<RepoSummary> = boundary.object({
  id: boundary.number,
  name: boundary.string,
  path: boundary.string,
  active: boundary.boolean,
  environment: boundary.optional(boundary.string),
  sessionCount: boundary.number,
});
const repoAddPreviewSchema: BoundarySchema<RepoAddPreview> = boundary.object({
  name: boundary.string,
  path: boundary.string,
  alreadyExists: boundary.boolean,
  wouldCreate: boundary.boolean,
  environment: boundary.optional(boundary.string),
});
const paneSummarySchema: BoundarySchema<PaneSummary> = boundary.object({
  id: boundary.string,
  paneId: boundary.string,
  name: boundary.string,
  status: boundary.string,
  worktreePath: boundary.string,
  repoId: boundary.number,
  repoName: boundary.optional(boundary.string),
  panelCount: boundary.number,
  pinned: boundary.boolean,
  createdAt: boundary.optional(boundary.string),
  lastActivity: boundary.optional(boundary.string),
  archived: boundary.optional(boundary.boolean),
});
const panelBlockedSchema: BoundarySchema<PanelBlockedState> = boundary.object({
  kind: boundary.enumeration('codex-update', 'agent-prompt', 'submission_unverified', 'unknown'),
  message: boundary.string,
  suggestedCommand: boundary.optional(boundary.string),
});
const panelStateSchema: BoundarySchema<PanelStateSummary> = boundary.object({
  initialized: boundary.boolean,
  isAlternateScreen: boundary.optional(boundary.boolean),
  activityStatus: boundary.optional(boundary.enumeration('active', 'idle')),
  isCliReady: boundary.optional(boundary.boolean),
  isCliPanel: boundary.optional(boundary.boolean),
  agentType: boundary.optional(agentSchema),
  lastActivity: boundary.optional(boundary.string),
});
const panelReadinessSchema: BoundarySchema<PanelReadiness> = boundary.object({
  ok: boundary.boolean,
  condition: boundary.string,
  matched: boundary.boolean,
  timedOut: boundary.boolean,
  elapsedMs: boundary.number,
  state: panelStateSchema,
  blocked: boundary.optional(panelBlockedSchema),
  nextCommand: boundary.optional(boundary.string),
});
const initialInputSchema: BoundarySchema<InitialInputDeliveryResult> = boundary.object({
  delivered: boundary.boolean,
  submitted: boundary.boolean,
  inputBytes: boundary.number,
  strategy: boundary.optional(boundary.enumeration('codex-ctrl-enter', 'enter', 'argument')),
  sequenceName: boundary.optional(boundary.enumeration('codex-ctrl-enter-cr', 'enter-cr', 'argument')),
  verifiedSubmitted: boundary.optional(boundary.boolean),
  staged: boundary.optional(boundary.boolean),
  attempts: boundary.optional(boundary.number),
  sentAt: boundary.optional(boundary.string),
  blocked: boundary.optional(panelBlockedSchema),
  error: boundary.optional(boundary.object({
    message: boundary.string,
    code: boundary.optional(boundary.string),
  })),
  nextCommand: boundary.optional(boundary.string),
});
const archiveSafetySchema: BoundarySchema<PaneArchiveSafetyCheck> = boundary.object({
  performed: boundary.boolean,
  hasUncommittedChanges: boundary.optional(boundary.boolean),
  hasUntrackedFiles: boundary.optional(boundary.boolean),
  hasUpstream: boundary.optional(boundary.boolean),
  unpushedCommits: boundary.optional(boundary.number),
});
const panelSummarySchema: BoundarySchema<PanelSummary> = boundary.object({
  id: boundary.string,
  panelId: boundary.string,
  paneId: boundary.string,
  type: boundary.string,
  title: boundary.string,
  active: boundary.boolean,
  initialized: boundary.optional(boundary.boolean),
  agentType: boundary.optional(boundary.string),
  isCliPanel: boundary.optional(boundary.boolean),
  position: boundary.optional(boundary.number),
  createdAt: boundary.optional(boundary.string),
  lastActiveAt: boundary.optional(boundary.string),
});

const repoListResultSchema: BoundarySchema<RepoListResult> = boundary.object({
  ok: boundary.literal(true),
  repos: boundary.array(repoSummarySchema),
});
const repoAddResultSchema: BoundarySchema<RepoAddResult> = boundary.object({
  ok: boundary.literal(true),
  created: boundary.boolean,
  dryRun: boundary.optional(boundary.boolean),
  repo: boundary.optional(repoSummarySchema),
  preview: boundary.optional(repoAddPreviewSchema),
});
const paneListResultSchema: BoundarySchema<PaneListResult> = boundary.object({
  ok: boundary.literal(true),
  repo: boundary.optional(repoSummarySchema),
  panes: boundary.array(paneSummarySchema),
});
const paneCreateResultSchema: BoundarySchema<PaneCreateResult> = boundary.object({
  ok: boundary.boolean,
  repo: repoSummarySchema,
  items: boundary.array(boundary.union(
    boundary.object({
      ok: boundary.literal(true),
      index: boundary.number,
      name: boundary.optional(boundary.string),
      pinned: boundary.boolean,
      sessionId: boundary.optional(boundary.string),
      panelId: boundary.optional(boundary.string),
      worktreePath: boundary.optional(boundary.string),
      nextCommand: boundary.optional(boundary.string),
      readiness: boundary.optional(panelReadinessSchema),
      initialInput: boundary.optional(initialInputSchema),
    }),
    boundary.object({
      ok: boundary.literal(false),
      index: boundary.number,
      name: boundary.optional(boundary.string),
      error: boundary.object({
      message: boundary.string,
      code: boundary.optional(boundary.string),
      }),
    }),
  )),
});
const paneArchiveResultSchema: BoundarySchema<PaneArchiveResult> = boundary.union(
  boundary.object({
    ok: boundary.literal(false),
    paneId: boundary.string,
    blocked: boundary.object({
      code: boundary.enumeration('uncommitted-changes', 'unpushed-commits', 'uncommitted-and-unpushed', 'status-unknown'),
      message: boundary.string,
      safetyCheck: archiveSafetySchema,
    }),
    nextCommand: boundary.string,
  }),
  boundary.object({
    ok: boundary.boolean,
    paneId: boundary.string,
    archived: boundary.literal(true),
    forced: boundary.boolean,
    worktreeCleanup: boundary.enumeration('completed', 'failed', 'timeout', 'not-applicable'),
    worktreePath: boundary.optional(boundary.string),
    safetyCheck: archiveSafetySchema,
  }),
);
const panePinResultSchema: BoundarySchema<PanePinResult> = boundary.object({
  ok: boundary.literal(true),
  paneId: boundary.string,
  pinned: boundary.boolean,
  dryRun: boundary.optional(boundary.literal(true)),
  favoritePinnedAt: boundary.optional(boundary.string),
});
const paneRenameResultSchema: BoundarySchema<PaneRenameResult> = boundary.object({
  ok: boundary.literal(true),
  dryRun: boundary.optional(boundary.literal(true)),
  pane: paneSummarySchema,
});
const panelListResultSchema: BoundarySchema<PanelListResult> = boundary.object({
  ok: boundary.literal(true),
  paneId: boundary.string,
  panels: boundary.array(panelSummarySchema),
});
const panelCreateResultSchema: BoundarySchema<PanelCreateResult> = boundary.object({
  ok: boundary.boolean,
  paneId: boundary.string,
  panelId: boundary.string,
  title: boundary.string,
  active: boundary.boolean,
  focused: boundary.boolean,
  tool: boundary.object({
    title: boundary.string,
    command: boundary.string,
    agent: boundary.optional(agentSchema),
  }),
  readiness: boundary.optional(panelReadinessSchema),
  initialInput: boundary.optional(initialInputSchema),
  nextCommand: boundary.optional(boundary.string),
});
const panelOutputResultSchema: BoundarySchema<PanelOutputResult> = boundary.object({
  ok: boundary.literal(true),
  panelId: boundary.string,
  paneId: boundary.optional(boundary.string),
  limit: boundary.number,
  returnedCount: boundary.number,
  hasMore: boundary.boolean,
  outputs: boundary.array(boundary.object({
    type: boundary.string,
    data: boundary.json,
    timestamp: boundary.string,
  })),
  text: boundary.string,
});
const panelInputResultSchema: BoundarySchema<PanelInputResult> = boundary.object({
  ok: boundary.literal(true),
  panelId: boundary.string,
  paneId: boundary.optional(boundary.string),
  inputBytes: boundary.number,
  sentAt: boundary.string,
  nextCommand: boundary.optional(boundary.string),
});
const panelScreenResultSchema: BoundarySchema<PanelScreenResult> = boundary.object({
  ok: boundary.literal(true),
  panelId: boundary.string,
  paneId: boundary.optional(boundary.string),
  source: boundary.enumeration('alternateScreen', 'scrollback', 'persistedOutput', 'empty'),
  limit: boundary.number,
  returnedLineCount: boundary.number,
  hasMore: boundary.boolean,
  text: boundary.string,
  state: panelStateSchema,
  nextCommand: boundary.optional(boundary.string),
});
const panelSubmitResultSchema: BoundarySchema<PanelSubmitResult> = boundary.object({
  ok: boundary.literal(true),
  panelId: boundary.string,
  paneId: boundary.optional(boundary.string),
  inputBytes: boundary.number,
  enter: boundary.literal('cr'),
  sentAt: boundary.string,
  nextCommand: boundary.optional(boundary.string),
});
const panelSubmitComposerResultSchema: BoundarySchema<PanelSubmitComposerResult> = boundary.object({
  ok: boundary.boolean,
  panelId: boundary.string,
  paneId: boundary.optional(boundary.string),
  inputBytes: boundary.number,
  strategy: boundary.enumeration('codex-ctrl-enter', 'enter'),
  sequenceName: boundary.enumeration('codex-ctrl-enter-cr', 'enter-cr'),
  verifiedSubmitted: boundary.boolean,
  sentAt: boundary.string,
  blocked: boundary.optional(panelBlockedSchema),
  nextCommand: boundary.optional(boundary.string),
});
const panelWaitResultSchema: BoundarySchema<PanelWaitResult> = boundary.object({
  ok: boundary.boolean,
  condition: boundary.string,
  matched: boundary.boolean,
  timedOut: boundary.boolean,
  elapsedMs: boundary.number,
  state: panelStateSchema,
  blocked: boundary.optional(panelBlockedSchema),
  nextCommand: boundary.optional(boundary.string),
  panelId: boundary.string,
  paneId: boundary.optional(boundary.string),
  screen: boundary.object({
    source: boundary.enumeration('alternateScreen', 'scrollback', 'persistedOutput', 'empty'),
    text: boundary.string,
    hasMore: boundary.boolean,
  }),
});
const agentDoctorResultSchema: BoundarySchema<AgentDoctorResult> = boundary.object({
  ok: boundary.boolean,
  agent: agentSchema,
  command: boundary.string,
  repo: boundary.optional(repoSummarySchema),
  environment: boundary.optional(boundary.string),
  available: boundary.boolean,
  executablePath: boundary.optional(boundary.string),
  version: boundary.optional(boundary.string),
  checks: boundary.array(boundary.object({
    name: boundary.string,
    ok: boundary.boolean,
    message: boundary.string,
  })),
  warnings: boundary.optional(boundary.array(boundary.string)),
});
const repoSelectorSchema: BoundarySchema<PaneCreateRequest['repo']> = boundary.union(
  boundary.nonEmptyString,
  boundary.object({ id: boundary.number }),
  boundary.object({ path: boundary.string }),
  boundary.object({ name: boundary.string }),
  boundary.object({ active: boundary.literal(true) }),
);
const paneToolInputSchema: BoundarySchema<PaneToolInput> = boundary.object({
  agent: boundary.optional(boundary.string),
  command: boundary.optional(boundary.string),
  title: boundary.optional(boundary.string),
  initialInput: boundary.optional(boundary.string),
});
const paneCreateRequestInputSchema: BoundarySchema<PaneCreateRequestInput> = boundary.object({
  repo: repoSelectorSchema,
  panes: boundary.array(boundary.object({
    name: boundary.string,
    worktreeName: boundary.optional(boundary.string),
    baseBranch: boundary.optional(boundary.string),
    sessionPrompt: boundary.optional(boundary.string),
    pinned: boundary.optional(boundary.boolean),
    tool: paneToolInputSchema,
  })),
  dryRun: boundary.optional(boundary.boolean),
  timeoutMs: boundary.optional(boundary.number),
  waitReady: boundary.optional(boundary.boolean),
  readyTimeoutMs: boundary.optional(boundary.number),
  concurrency: boundary.optional(boundary.number),
  noFocus: boundary.optional(boundary.boolean),
  focus: boundary.optional(boundary.boolean),
  source: boundary.optional(boundary.enumeration('user', 'agent')),
});

export async function runReposList(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:repos:list', [], repoListResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
    return 0;
  }

  if (result.repos.length === 0) {
    console.log('No Pane repositories found.');
    return 0;
  }

  for (const repo of result.repos) {
    const marker = repo.active ? '*' : ' ';
    const environment = repo.environment ? ` ${repo.environment}` : '';
    console.log(`${marker} ${repo.id}\t${repo.name}\t${repo.path}\t${repo.sessionCount} sessions${environment}`);
  }

  return 0;
}

export async function runReposAdd(parsed: ParsedArgs): Promise<number> {
  const request = buildRepoAddRequest(parsed);
  await confirmRepoAdd(parsed, request);

  const result = await invokeDaemon('runpane:repos:add', [request], repoAddResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    printRepoAddResult(result);
  }

  return 0;
}

export async function runPanesList(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:panes:list', [{
    repo: parsed.repo,
  }], paneListResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
    return 0;
  }

  printPaneListResult(result);
  return 0;
}

export async function runPanesCreate(parsed: ParsedArgs): Promise<number> {
  const request = await buildPaneCreateRequest(parsed);
  await confirmPaneCreate(parsed, request);

  const result = await invokeDaemon('runpane:panes:create', [request], paneCreateResultSchema, {
    paneDir: parsed.paneDir,
    timeoutMs: (parsed.timeoutMs ?? 120_000) + (parsed.readyTimeoutMs ?? 30_000) + 10_000,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    printPaneCreateResult(result);
  }

  return result.ok ? 0 : 1;
}

export async function runPanesArchive(parsed: ParsedArgs): Promise<number> {
  if (!parsed.paneId) {
    throw new Error('runpane panes archive requires --pane.');
  }

  const request: PaneArchiveRequest = {
    paneId: parsed.paneId,
    force: parsed.force || undefined,
    source: parsed.source === 'user' || parsed.source === 'agent' ? parsed.source : undefined,
  };

  await confirmPaneArchive(parsed, request);

  const result = await invokeDaemon('runpane:panes:archive', [request], paneArchiveResultSchema, {
    paneDir: parsed.paneDir,
    timeoutMs: 40_000,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    printPaneArchiveResult(result);
  }

  return result.ok ? 0 : 1;
}

export async function runPanesPin(parsed: ParsedArgs, pinned: boolean): Promise<number> {
  if (!parsed.paneId) {
    throw new Error(`runpane panes ${pinned ? 'pin' : 'unpin'} requires --pane.`);
  }

  const request: PanePinRequest = {
    paneId: parsed.paneId,
    pinned,
  };
  if (parsed.dryRun) request.dryRun = true;
  await confirmPanePin(parsed, request);

  const result = await invokeDaemon('runpane:panes:pin', [request], panePinResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    console.log(`${result.pinned ? 'Pinned' : 'Unpinned'} ${result.paneId}`);
  }

  return 0;
}

export async function runPanesRename(parsed: ParsedArgs): Promise<number> {
  if (!parsed.paneId) {
    throw new Error('runpane panes rename requires --pane.');
  }
  const name = parsed.name?.trim();
  if (!name) {
    throw new Error('runpane panes rename requires a non-empty --name.');
  }

  const request: PaneRenameRequest = {
    paneId: parsed.paneId,
    name,
  };
  if (parsed.dryRun) request.dryRun = true;
  await confirmPaneRename(parsed, request);

  const result = await invokeDaemon('runpane:panes:rename', [request], paneRenameResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    console.log(`${parsed.dryRun ? 'Would rename' : 'Renamed'} ${result.pane.paneId} to ${result.pane.name}`);
  }

  return 0;
}

export async function runPanelsList(parsed: ParsedArgs): Promise<number> {
  if (!parsed.paneId) {
    throw new Error('runpane panels list requires --pane.');
  }

  const result = await invokeDaemon('runpane:panels:list', [{
    paneId: parsed.paneId,
  }], panelListResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
    return 0;
  }

  printPanelListResult(result);
  return 0;
}

export async function runPanelsCreate(parsed: ParsedArgs): Promise<number> {
  const request = await buildPanelCreateRequest(parsed);
  await confirmPanelCreate(parsed, request);

  const result = await invokeDaemon('runpane:panels:create', [request], panelCreateResultSchema, {
    paneDir: parsed.paneDir,
    timeoutMs: (parsed.readyTimeoutMs ?? 30_000) + 10_000,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    printPanelCreateResult(result);
  }

  return result.ok ? 0 : 1;
}

export async function runPanelsOutput(parsed: ParsedArgs): Promise<number> {
  if (!parsed.panelId) {
    throw new Error('runpane panels output requires --panel.');
  }

  const result = await invokeDaemon('runpane:panels:output', [{
    panelId: parsed.panelId,
    limit: parsed.limit,
  }], panelOutputResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
    return 0;
  }

  output.write(result.text);
  if (result.text && !result.text.endsWith('\n')) {
    output.write('\n');
  }
  return 0;
}

export async function runPanelsInput(parsed: ParsedArgs): Promise<number> {
  const request = buildPanelInputRequest(parsed);
  await confirmPanelInput(parsed, request);

  const result = await invokeDaemon('runpane:panels:input', [request], panelInputResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    console.log(`Sent ${result.inputBytes} byte${result.inputBytes === 1 ? '' : 's'} to panel ${result.panelId}.`);
  }

  return 0;
}

export async function runPanelsScreen(parsed: ParsedArgs): Promise<number> {
  if (!parsed.panelId) {
    throw new Error('runpane panels screen requires --panel.');
  }

  const result = await invokeDaemon('runpane:panels:screen', [{
    panelId: parsed.panelId,
    limit: parsed.limit,
  }], panelScreenResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
    return 0;
  }

  output.write(result.text);
  if (result.text && !result.text.endsWith('\n')) {
    output.write('\n');
  }
  return 0;
}

export async function runPanelsSubmit(parsed: ParsedArgs): Promise<number> {
  const request = buildPanelInputRequest(parsed, 'submit');
  await confirmPanelInput(parsed, request, 'submit');

  const result = await invokeDaemon('runpane:panels:submit', [request], panelSubmitResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    console.log(`Submitted ${result.inputBytes} byte${result.inputBytes === 1 ? '' : 's'} with Enter to panel ${result.panelId}.`);
    if (result.nextCommand) {
      console.log(`Next: ${result.nextCommand}`);
    }
  }

  return 0;
}

export async function runPanelsSubmitComposer(parsed: ParsedArgs): Promise<number> {
  if (!parsed.panelId) {
    throw new Error('runpane panels submit-composer requires --panel.');
  }
  await confirmPanelSubmitComposer(parsed);

  const result = await invokeDaemon('runpane:panels:submit-composer', [{
    panelId: parsed.panelId,
    strategy: parsed.composerStrategy,
  }], panelSubmitComposerResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    const verified = result.verifiedSubmitted ? ' verified' : ' unverified';
    console.log(`${result.ok ? 'Submitted' : 'Could not verify'} composer with ${result.sequenceName} to panel ${result.panelId}.${verified}`);
    if (result.blocked) {
      console.log(`Blocked: ${result.blocked.message}`);
    }
    if (result.nextCommand) {
      console.log(`Next: ${result.nextCommand}`);
    }
  }

  return result.ok ? 0 : 1;
}

export async function runPanelsWait(parsed: ParsedArgs): Promise<number> {
  if (!parsed.panelId) {
    throw new Error('runpane panels wait requires --panel.');
  }

  const result = await invokeDaemon('runpane:panels:wait', [{
    panelId: parsed.panelId,
    condition: parsed.waitCondition,
    contains: parsed.contains,
    timeoutMs: parsed.timeoutMs,
    intervalMs: parsed.intervalMs,
  }], panelWaitResultSchema, {
    paneDir: parsed.paneDir,
    timeoutMs: (parsed.timeoutMs ?? 30_000) + 5_000,
  });

  if (parsed.json) {
    printJson(result);
    return result.ok ? 0 : 1;
  }

  printPanelWaitResult(result);
  return result.ok ? 0 : 1;
}

export async function runAgentsDoctor(parsed: ParsedArgs): Promise<number> {
  if (!parsed.agent) {
    throw new Error(`runpane agents doctor requires --agent ${RUNPANE_CONTRACT.enums.agents.join('|')}.`);
  }

  const result = await invokeDaemon('runpane:agents:doctor', [{
    agent: parsed.agent,
    repo: parsed.repo,
  }], agentDoctorResultSchema, {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
    return result.ok ? 0 : 1;
  }

  printAgentDoctorResult(result);
  return result.ok ? 0 : 1;
}

function buildRepoAddRequest(parsed: ParsedArgs): RepoAddRequest {
  if (!parsed.repoPath) {
    throw new Error('runpane repos add requires --path.');
  }

  return {
    path: parsed.repoPath,
    name: parsed.name,
    dryRun: parsed.dryRun || undefined,
  };
}

function buildPanelInputRequest(parsed: ParsedArgs, command: 'input' | 'submit' = 'input'): PanelInputRequest {
  if (!parsed.panelId) {
    throw new Error(`runpane panels ${command} requires --panel.`);
  }
  if (parsed.panelInput !== undefined && parsed.panelInputFile) {
    throw new Error('Use either --text or --input-file, not both.');
  }
  if (parsed.panelInput === undefined && !parsed.panelInputFile) {
    throw new Error(`runpane panels ${command} requires --text or --input-file.`);
  }

  return {
    panelId: parsed.panelId,
    input: parsed.panelInputFile ? readInputSource(parsed.panelInputFile) : parsed.panelInput ?? '',
  };
}

async function buildPanelCreateRequest(parsed: ParsedArgs): Promise<PanelCreateRequest> {
  if (!parsed.paneId) {
    throw new Error('runpane panels create requires --pane.');
  }
  if (parsed.noFocus && parsed.focus) {
    throw new Error('Use either --focus or --no-focus, not both.');
  }
  const source = parsed.source === 'user' || parsed.source === 'agent' ? parsed.source : undefined;

  return {
    paneId: parsed.paneId,
    type: 'terminal',
    tool: await buildToolSpec(parsed, 'panels create'),
    noFocus: !parsed.focus && (parsed.noFocus || source === 'agent' || Boolean(parsed.agent)) ? true : undefined,
    focus: parsed.focus || undefined,
    source,
    waitReady: parsed.waitReady || undefined,
    readyTimeoutMs: parsed.readyTimeoutMs,
  };
}

async function buildPaneCreateRequest(parsed: ParsedArgs): Promise<PaneCreateRequest> {
  if (parsed.fromJson) {
    const payload = JSON.parse(stripUtf8Bom(readInputSource(parsed.fromJson)));
    const request = parsePaneCreateRequestPayload(payload);
    if (parsed.dryRun) {
      request.dryRun = true;
    }
    if (parsed.timeoutMs !== undefined) {
      request.timeoutMs = parsed.timeoutMs;
    }
    if (parsed.waitReady) {
      request.waitReady = true;
    }
    if (parsed.readyTimeoutMs !== undefined) {
      request.readyTimeoutMs = parsed.readyTimeoutMs;
    }
    if (parsed.concurrency !== undefined) {
      request.concurrency = parsed.concurrency;
    }
    if (parsed.pinned) {
      request.panes = request.panes.map(item => ({ ...item, pinned: true }));
    }
    applyPaneFocusOptions(parsed, request);
    return request;
  }

  if (!parsed.repo) {
    throw new Error('runpane panes create requires --repo unless --from-json is used.');
  }
  if (!parsed.name) {
    throw new Error('runpane panes create requires --name unless --from-json is used.');
  }

  const tool = await buildToolSpec(parsed);
  const source = parsed.source === 'user' || parsed.source === 'agent' ? parsed.source : undefined;
  if (parsed.noFocus && parsed.focus) {
    throw new Error('Use either --focus or --no-focus, not both.');
  }
  const request: PaneCreateRequest = {
    repo: parsed.repo,
    panes: [{
      name: parsed.name,
      worktreeName: parsed.worktreeName,
      baseBranch: parsed.baseBranch,
      pinned: parsed.pinned || undefined,
      tool,
    }],
    dryRun: parsed.dryRun || undefined,
    timeoutMs: parsed.timeoutMs,
    waitReady: parsed.waitReady || undefined,
    readyTimeoutMs: parsed.readyTimeoutMs,
    concurrency: parsed.concurrency,
    noFocus: !parsed.focus && (parsed.noFocus || source === 'agent' || Boolean(parsed.agent)) ? true : undefined,
    focus: parsed.focus || undefined,
    source,
  };

  return request;
}

function applyPaneFocusOptions(parsed: ParsedArgs, request: PaneCreateRequest): void {
  if (parsed.noFocus && parsed.focus) {
    throw new Error('Use either --focus or --no-focus, not both.');
  }
  const source = parsed.source === 'user' || parsed.source === 'agent' ? parsed.source : undefined;
  if (!parsed.focus && (parsed.noFocus || source === 'agent' || Boolean(parsed.agent))) {
    request.noFocus = true;
  }
  if (parsed.focus) {
    request.focus = true;
  }
  if (source) {
    request.source = source;
  }
}

async function confirmRepoAdd(parsed: ParsedArgs, request: RepoAddRequest): Promise<void> {
  if (parsed.dryRun || parsed.yes) {
    return;
  }

  if (!isInteractiveShell()) {
    throw new Error('runpane repos add mutates Pane state. Rerun with --yes in non-interactive shells.');
  }

  const label = request.name ? `${request.name} at ${request.path}` : request.path;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`Add Pane repo ${label}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function buildToolSpec(parsed: ParsedArgs, command = 'panes create'): Promise<PaneToolSpec> {
  if (parsed.agent && parsed.toolCommand) {
    throw new Error('Use either --agent or --tool-command, not both.');
  }

  const initialInput = resolveInitialInput(parsed);
  let agent = parsed.agent;

  if (!agent && !parsed.toolCommand) {
    if (!isInteractiveShell()) {
      throw new Error(`runpane ${command} requires --agent or --tool-command in non-interactive shells.`);
    }
    agent = await askAgentChoice();
  }

  if (agent) {
    return {
      agent,
      title: parsed.title,
      initialInput,
    };
  }

  if (!parsed.toolCommand) {
    throw new Error(`runpane ${command} requires --agent or --tool-command.`);
  }

  return {
    command: parsed.toolCommand,
    title: parsed.title,
    initialInput,
  };
}

function resolveInitialInput(parsed: ParsedArgs): string | undefined {
  if (parsed.initialInput && parsed.initialInputFile) {
    throw new Error('Use either --initial-input/--prompt or --initial-input-file, not both.');
  }

  if (parsed.initialInputFile) {
    return readInputSource(parsed.initialInputFile);
  }

  return parsed.initialInput;
}

async function confirmPaneCreate(parsed: ParsedArgs, request: PaneCreateRequest): Promise<void> {
  if (parsed.dryRun || parsed.yes) {
    return;
  }

  if (!isInteractiveShell()) {
    throw new Error('runpane panes create mutates Pane state. Rerun with --yes in non-interactive shells.');
  }

  const rl = createInterface({ input, output });
  try {
    const count = request.panes.length;
    const answer = (await rl.question(`Create ${count} Pane pane${count === 1 ? '' : 's'}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function confirmPaneArchive(parsed: ParsedArgs, request: PaneArchiveRequest): Promise<void> {
  if (parsed.yes) {
    return;
  }

  if (!isInteractiveShell()) {
    throw new Error('runpane panes archive mutates Pane state. Rerun with --yes in non-interactive shells.');
  }

  const rl = createInterface({ input, output });
  try {
    const suffix = request.force ? ' (including any uncommitted or unpushed work)' : '';
    const answer = (await rl.question(`Archive pane ${request.paneId}${suffix}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function confirmPanePin(parsed: ParsedArgs, request: PanePinRequest): Promise<void> {
  if (parsed.dryRun || parsed.yes) {
    return;
  }

  const command = request.pinned ? 'pin' : 'unpin';
  if (!isInteractiveShell()) {
    throw new Error(`runpane panes ${command} mutates Pane state. Rerun with --yes in non-interactive shells.`);
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${request.pinned ? 'Pin' : 'Unpin'} pane ${request.paneId}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function confirmPaneRename(parsed: ParsedArgs, request: PaneRenameRequest): Promise<void> {
  if (parsed.dryRun || parsed.yes) {
    return;
  }

  if (!isInteractiveShell()) {
    throw new Error('runpane panes rename mutates Pane state. Rerun with --yes in non-interactive shells.');
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`Rename pane ${request.paneId} to ${request.name}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function confirmPanelCreate(parsed: ParsedArgs, request: PanelCreateRequest): Promise<void> {
  if (parsed.yes) {
    return;
  }

  if (!isInteractiveShell()) {
    throw new Error('runpane panels create mutates Pane state. Rerun with --yes in non-interactive shells.');
  }

  const label = 'agent' in request.tool ? request.tool.agent : request.tool.command;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`Create a terminal panel for ${label} in pane ${request.paneId}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function confirmPanelInput(
  parsed: ParsedArgs,
  request: PanelInputRequest,
  command: 'input' | 'submit' = 'input',
): Promise<void> {
  if (parsed.yes) {
    return;
  }

  if (!isInteractiveShell()) {
    throw new Error(`runpane panels ${command} mutates a Pane terminal. Rerun with --yes in non-interactive shells.`);
  }

  const rl = createInterface({ input, output });
  try {
    const byteCount = Buffer.byteLength(request.input, 'utf8');
    const verb = command === 'submit' ? 'Submit' : 'Send';
    const suffix = command === 'submit' ? ' plus Enter' : '';
    const answer = (await rl.question(`${verb} ${byteCount} byte${byteCount === 1 ? '' : 's'}${suffix} to panel ${request.panelId}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function confirmPanelSubmitComposer(parsed: ParsedArgs): Promise<void> {
  if (parsed.yes) {
    return;
  }

  if (!isInteractiveShell()) {
    throw new Error('runpane panels submit-composer mutates a Pane terminal. Rerun with --yes in non-interactive shells.');
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`Submit composer in panel ${parsed.panelId}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function askAgentChoice(): Promise<RunpaneAgent> {
  const agents = RUNPANE_CONTRACT.enums.agents;
  const rl = createInterface({ input, output });
  try {
    console.log('Choose an agent:');
    agents.forEach((agent, index) => {
      const template = RUNPANE_CONTRACT.agentTemplates[agent];
      console.log(`${index + 1}) ${template.title}`);
    });

    while (true) {
      const answer = (await rl.question('Agent [1]: ')).trim().toLowerCase();
      if (answer === '') {
        return agents[0];
      }
      const byIndex = Number(answer);
      if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= agents.length) {
        return agents[byIndex - 1];
      }
      try {
        return decodeBoundary(answer, agentSchema);
      } catch {
        // Keep prompting until the user chooses a supported agent.
      }
      console.log(`Choose one of: ${agents.join(', ')}`);
    }
  } finally {
    rl.close();
  }
}

function readInputSource(source: string): string {
  if (source === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(source, 'utf8');
}

function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF+/, '');
}

function printJson<Value>(value: Value): void {
  console.log(JSON.stringify(value, null, 2));
}

function printRepoAddResult(result: RepoAddResult): void {
  if (result.dryRun && result.preview) {
    if (result.preview.alreadyExists) {
      console.log(`Repo already exists: ${result.preview.name}\t${result.preview.path}`);
      return;
    }
    console.log(`Would add Pane repo ${result.preview.name}\t${result.preview.path}`);
    return;
  }

  if (result.repo) {
    const action = result.created ? 'Added Pane repo' : 'Repo already exists';
    console.log(`${action}: ${result.repo.id}\t${result.repo.name}\t${result.repo.path}`);
    return;
  }

  console.log('Repo add completed.');
}

function printPaneListResult(result: PaneListResult): void {
  if (result.panes.length === 0) {
    console.log('No Pane sessions found.');
    return;
  }

  for (const pane of result.panes) {
    const repo = pane.repoName ? ` ${pane.repoName}` : '';
    const pinned = pane.pinned ? ' pinned' : '';
    console.log(`${pane.id}\t${pane.name}\t${pane.status}${pinned}\t${pane.panelCount} panels\t${pane.worktreePath}${repo}`);
  }
}

function printPaneCreateResult(result: PaneCreateResult): void {
  for (const item of result.items) {
    if (item.ok) {
      const worktree = item.worktreePath ? ` at ${item.worktreePath}` : '';
      console.log(`Created ${item.name ?? `pane ${item.index}`}: session ${item.sessionId ?? 'unknown'} panel ${item.panelId ?? 'unknown'}${worktree}`);
      if (item.readiness) {
        console.log(`  Ready: ${item.readiness.ok ? 'yes' : item.readiness.timedOut ? 'timed out' : 'blocked'} after ${item.readiness.elapsedMs}ms`);
        if (item.readiness.blocked) {
          console.log(`  Blocked: ${item.readiness.blocked.message}`);
        }
      }
      printInitialInputDelivery(item.initialInput, '  ');
      if (item.nextCommand) {
        console.log(`  Next: ${item.nextCommand}`);
      }
      continue;
    }
    console.error(`Failed ${item.name ?? `pane ${item.index}`}: ${item.error.message}`);
  }
}

function printPaneArchiveResult(result: PaneArchiveResult): void {
  if (!('archived' in result)) {
    console.error(`Refused to archive pane ${result.paneId}: ${result.blocked.message}`);
    console.error(`Next: ${result.nextCommand}`);
    return;
  }

  console.log(`Archived pane ${result.paneId}${result.forced ? ' (forced)' : ''}. Worktree cleanup: ${result.worktreeCleanup}.`);
}

function printPanelCreateResult(result: PanelCreateResult): void {
  console.log(`Created panel ${result.panelId} in pane ${result.paneId}: ${result.title}${result.active ? ' active' : ' background'}`);
  if (result.readiness) {
    console.log(`Ready: ${result.readiness.ok ? 'yes' : result.readiness.timedOut ? 'timed out' : 'blocked'} after ${result.readiness.elapsedMs}ms`);
    if (result.readiness.blocked) {
      console.log(`Blocked: ${result.readiness.blocked.message}`);
    }
  }
  printInitialInputDelivery(result.initialInput);
  if (result.nextCommand) {
    console.log(`Next: ${result.nextCommand}`);
  }
}

function printInitialInputDelivery(initialInput: InitialInputDeliveryResult | undefined, prefix = ''): void {
  if (!initialInput) {
    return;
  }

  const status = initialInput.submitted
    ? 'submitted'
    : initialInput.delivered
      ? 'delivered but not verified submitted'
      : 'not delivered';
  const strategy = initialInput.sequenceName ? ` via ${initialInput.sequenceName}` : '';
  const attempts = initialInput.attempts === undefined ? '' : ` after ${initialInput.attempts} attempt${initialInput.attempts === 1 ? '' : 's'}`;
  const staged = initialInput.staged === undefined ? '' : `; staged: ${initialInput.staged ? 'yes' : 'no'}`;
  console.log(`${prefix}Initial input: ${status}${strategy}${attempts}${staged}`);
  if (initialInput.blocked) {
    console.log(`${prefix}Initial input blocked: ${initialInput.blocked.message}`);
  }
  if (initialInput.error) {
    console.log(`${prefix}Initial input error: ${initialInput.error.message}`);
  }
}

function printPanelWaitResult(result: PanelWaitResult): void {
  if (result.ok) {
    console.log(`Matched ${result.condition} for panel ${result.panelId} after ${result.elapsedMs}ms.`);
  } else if (result.blocked) {
    console.log(`Blocked waiting for ${result.condition} on panel ${result.panelId}: ${result.blocked.message}`);
  } else if (result.timedOut) {
    console.log(`Timed out waiting for ${result.condition} on panel ${result.panelId} after ${result.elapsedMs}ms.`);
  } else {
    console.log(`Did not match ${result.condition} for panel ${result.panelId}.`);
  }

  const statusParts = [
    result.state.initialized ? 'initialized' : 'not-initialized',
    result.state.activityStatus,
    result.state.isCliReady === undefined ? undefined : result.state.isCliReady ? 'cli-ready' : 'cli-not-ready',
    result.state.agentType,
  ].filter(Boolean);
  if (statusParts.length > 0) {
    console.log(`State: ${statusParts.join(', ')}`);
  }
  if (result.nextCommand) {
    console.log(`Next: ${result.nextCommand}`);
  }
}

function printAgentDoctorResult(result: AgentDoctorResult): void {
  const repo = result.repo ? ` in ${result.repo.name}` : '';
  const environment = result.environment ? ` (${result.environment})` : '';
  console.log(`${result.agent}: ${result.available ? 'available' : 'not available'}${repo}${environment}`);
  if (result.executablePath) {
    console.log(`Path: ${result.executablePath}`);
  }
  if (result.version) {
    console.log(`Version: ${result.version}`);
  }
  for (const check of result.checks) {
    console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.message}`);
  }
  for (const warning of result.warnings ?? []) {
    console.log(`Warning: ${warning}`);
  }
}

function printPanelListResult(result: PanelListResult): void {
  if (result.panels.length === 0) {
    console.log(`No panels found for pane ${result.paneId}.`);
    return;
  }

  for (const panel of result.panels) {
    const marker = panel.active ? '*' : ' ';
    const initialized = panel.initialized === undefined ? '' : panel.initialized ? ' initialized' : ' not-initialized';
    const agent = panel.agentType ? ` ${panel.agentType}` : '';
    console.log(`${marker} ${panel.id}\t${panel.type}\t${panel.title}${initialized}${agent}`);
  }
}

function isInteractiveShell(): boolean {
  return Boolean(input.isTTY && output.isTTY && !process.env.CI);
}

function parsePaneCreateRequestPayload(value: JsonValue): PaneCreateRequest {
  let decoded: PaneCreateRequestInput;
  try {
    decoded = decodeBoundary(value, paneCreateRequestInputSchema);
  } catch {
    throw new Error('--from-json payload must be an object.');
  }

  if (decoded.panes.length === 0) {
    throw new Error('--from-json payload must include at least one pane.');
  }
  if (decoded.noFocus === true && decoded.focus === true) {
    throw new Error('--from-json payload cannot include both noFocus and focus.');
  }

  return {
    ...decoded,
    panes: decoded.panes.map(parsePaneCreateItemPayload),
  };
}

function parsePaneCreateItemPayload(value: PaneCreateItemInput, index: number): PaneCreateItem {
  if (value.name.trim().length === 0) {
    throw new Error(`--from-json pane ${index} must include a name.`);
  }

  return {
    name: value.name,
    worktreeName: value.worktreeName,
    baseBranch: value.baseBranch,
    sessionPrompt: value.sessionPrompt,
    pinned: value.pinned,
    tool: parsePaneToolSpecPayload(value.tool, index),
  };
}

function parsePaneToolSpecPayload(value: PaneToolInput, index: number): PaneToolSpec {
  if (value.agent !== undefined) {
    let agent: RunpaneAgent;
    try {
      agent = decodeBoundary(value.agent, agentSchema);
    } catch {
      throw new Error(`--from-json pane ${index} includes an unsupported agent.`);
    }
    return {
      agent,
      title: value.title,
      initialInput: value.initialInput,
    };
  }

  if (value.command !== undefined && value.command.trim().length > 0) {
    return {
      command: value.command,
      title: value.title,
      initialInput: value.initialInput,
    };
  }

  throw new Error(`--from-json pane ${index} tool must include agent or command.`);
}
