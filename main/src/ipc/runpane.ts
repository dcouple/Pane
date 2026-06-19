import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PathResolver } from '../utils/pathResolver';
import { sanitizeTerminalOutput } from '../utils/terminalOutputSanitizer';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager, type TerminalPanelSnapshot } from '../services/terminalPanelManager';
import { ensureProjectAgentContext } from '../services/agentContextManager';
import type { Project } from '../database/models';
import type { Session, SessionOutput } from '../types/session';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import type {
  RunpaneAgentId,
  RunpaneAgentDoctorRequest,
  RunpaneAgentDoctorResult,
  RunpaneDoctorResult,
  RunpanePaneListRequest,
  RunpanePaneListResult,
  RunpanePaneCreateFailureItem,
  RunpanePaneCreateItem,
  RunpanePaneCreateRequest,
  RunpanePaneCreateResult,
  RunpanePaneCreateResultItem,
  RunpanePaneReadiness,
  RunpanePanelBlockedState,
  RunpanePanelInputRequest,
  RunpanePanelInputResult,
  RunpanePanelListRequest,
  RunpanePanelListResult,
  RunpanePanelOutputRecord,
  RunpanePanelOutputRequest,
  RunpanePanelOutputResult,
  RunpanePanelScreenRequest,
  RunpanePanelScreenResult,
  RunpanePanelScreenSource,
  RunpanePanelStateSummary,
  RunpanePanelSubmitRequest,
  RunpanePanelSubmitResult,
  RunpanePanelWaitCondition,
  RunpanePanelWaitRequest,
  RunpanePanelWaitResult,
  RunpaneRepoAddRequest,
  RunpaneRepoAddResult,
  RunpaneRepoListResult,
  RunpaneRepoSelector,
  RunpaneRepoSummary,
  RunpaneResolvedTool,
  RunpaneToolSpec,
} from '../../../shared/types/runpaneOrchestration';

const RUNPANE_CHANNELS = [
  'runpane:doctor',
  'runpane:repos:list',
  'runpane:repos:add',
  'runpane:panes:list',
  'runpane:panes:create',
  'runpane:panels:list',
  'runpane:panels:output',
  'runpane:panels:input',
  'runpane:panels:screen',
  'runpane:panels:submit',
  'runpane:panels:wait',
  'runpane:agents:doctor',
] as const;

const AGENT_TEMPLATES = RUNPANE_CONTRACT.agentTemplates;
const AGENT_IDS = new Set<string>(RUNPANE_CONTRACT.enums.agents);
const DEFAULT_PANEL_OUTPUT_LIMIT = 200;
const DEFAULT_PANEL_SCREEN_LIMIT = 80;
const DEFAULT_PANEL_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_PANEL_WAIT_INTERVAL_MS = 500;

export function registerRunpaneHandlers(
  _ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const { databaseService, sessionManager, taskQueue, configManager } = services;

  commandRegistry.register('runpane:doctor', async (): Promise<RunpaneDoctorResult> => {
    return withRunpaneAction(services, 'doctor', {}, () => {
      const repos = databaseService.getAllProjects().map((project) =>
        projectToRepoSummary(project, sessionManager.getSessionsForProject(project.id).length)
      );
      return {
        ok: true,
        app: {
          version: services.app.getVersion(),
          isPackaged: services.app.isPackaged,
          platform: process.platform,
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
        },
        daemon: {
          channels: [...runpaneDaemonChannels()],
        },
        repos: {
          count: repos.length,
          active: repos.find(repo => repo.active),
        },
        agentContext: {
          recommendedFirstCommands: [
            'runpane doctor --json',
            'runpane agent-context --json',
            'runpane agent-context --command "<command>" --json',
          ],
        },
      };
    }, result => ({ resultCount: result.repos.count }));
  });

  commandRegistry.register('runpane:repos:list', async (): Promise<RunpaneRepoListResult> => {
    return withRunpaneAction(services, 'repos:list', {}, () => {
      const repos = databaseService.getAllProjects().map((project) =>
        projectToRepoSummary(project, sessionManager.getSessionsForProject(project.id).length)
      );
      return { ok: true, repos };
    }, result => ({ resultCount: result.repos.length }));
  });

  commandRegistry.register('runpane:repos:add', async (request: unknown): Promise<RunpaneRepoAddResult> => {
    return withRunpaneAction(services, 'repos:add', {}, async () => {
      const normalized = parseRepoAddRequest(request);
      const existing = resolveProjectByPath(databaseService.getAllProjects(), normalized.path);

      if (existing) {
        return {
          ok: true,
          created: false,
          dryRun: normalized.dryRun || undefined,
          repo: projectToRepoSummary(existing, sessionManager.getSessionsForProject(existing.id).length),
          preview: normalized.dryRun
            ? {
                name: existing.name,
                path: existing.path,
                alreadyExists: true,
                wouldCreate: false,
                environment: new PathResolver(existing).environment,
              }
            : undefined,
        };
      }

      validateRepositoryPath(normalized.path);

      const preview = {
        name: normalized.name,
        path: normalized.path,
        alreadyExists: false,
        wouldCreate: true,
        environment: new PathResolver({ path: normalized.path }).environment,
      };

      if (normalized.dryRun) {
        return {
          ok: true,
          created: false,
          dryRun: true,
          preview,
        };
      }

      const project = databaseService.createProject(
        normalized.name,
        normalized.path,
        undefined,
        undefined,
        undefined,
        'ignore',
      );

      try {
        await ensureProjectAgentContext(project, configManager.getConfig());
      } catch (error) {
        console.warn('[Runpane] Failed to update Pane agent context after repo add:', error);
      }

      return {
        ok: true,
        created: true,
        repo: projectToRepoSummary(project, 0),
      };
    }, result => ({ repoId: result.repo?.id, resultCount: result.created ? 1 : 0 }));
  });

  commandRegistry.register('runpane:panes:list', async (request: unknown = {}): Promise<RunpanePaneListResult> => {
    return withRunpaneAction(services, 'panes:list', {}, () => {
      const normalized = parsePaneListRequest(request);
      const projects = databaseService.getAllProjects();
      const scopedProject = normalized.repo ? resolveRepoSelector(projects, normalized.repo) : undefined;
      const targetProjects = scopedProject ? [scopedProject] : projects;

      const panes = targetProjects.flatMap((project) =>
        sessionManager
          .getSessionsForProject(project.id)
          .filter(session => !session.archived)
          .map(session => sessionToPaneSummary(session, project))
      );

      return {
        ok: true,
        repo: scopedProject
          ? projectToRepoSummary(scopedProject, sessionManager.getSessionsForProject(scopedProject.id).length)
          : undefined,
        panes,
      };
    }, result => ({ repoId: result.repo?.id, resultCount: result.panes.length }));
  });

  commandRegistry.register('runpane:panes:create', async (request: unknown): Promise<RunpanePaneCreateResult> => {
    return withRunpaneAction(services, 'panes:create', {}, async () => {
      const normalized = parsePaneCreateRequest(request);
      const repo = resolveRepoSelector(databaseService.getAllProjects(), normalized.repo);
      const repoSummary = projectToRepoSummary(repo, sessionManager.getSessionsForProject(repo.id).length);

      if (normalized.dryRun) {
        return {
          ok: true,
          repo: repoSummary,
          items: normalized.panes.map((pane, index) => ({
            ok: true,
            index,
            name: pane.name,
            tool: describeTool(resolveToolSpec(pane.tool)),
          })),
        };
      }

      if (!taskQueue) {
        throw new Error('Task queue not initialized');
      }

      const items = await mapSequentially(
        normalized.panes,
        (item, index) => createPaneItem(services, repo, item, index, {
          timeoutMs: normalized.timeoutMs,
          waitReady: normalized.waitReady,
          readyTimeoutMs: normalized.readyTimeoutMs,
        }),
      );

      return {
        ok: items.every(isPaneCreateItemSuccessful),
        repo: repoSummary,
        items,
      };
    }, result => ({ repoId: result.repo.id, resultCount: result.items.length }));
  });

  commandRegistry.register('runpane:panels:list', async (request: unknown): Promise<RunpanePanelListResult> => {
    return withRunpaneAction(services, 'panels:list', {}, () => {
      const normalized = parsePanelListRequest(request);
      const pane = resolvePane(sessionManager, normalized.paneId);
      const panels = panelManager.getPanelsForSession(pane.id).map(panelToSummary);

      return {
        ok: true,
        paneId: pane.id,
        panels,
      };
    }, result => ({ paneId: result.paneId, resultCount: result.panels.length }));
  });

  commandRegistry.register('runpane:panels:output', async (request: unknown): Promise<RunpanePanelOutputResult> => {
    return withRunpaneAction(services, 'panels:output', {}, () => {
      const normalized = parsePanelOutputRequest(request);
      const panel = resolvePanel(normalized.panelId);
      const limit = normalized.limit ?? DEFAULT_PANEL_OUTPUT_LIMIT;
      const scrollbackResult = panel.type === 'terminal' ? panelScrollbackOutput(panel, limit) : null;

      if (scrollbackResult) {
        return {
          ok: true,
          panelId: panel.id,
          paneId: panel.sessionId,
          limit,
          returnedCount: scrollbackResult.text ? 1 : 0,
          hasMore: scrollbackResult.hasMore,
          outputs: scrollbackResult.text
            ? [{
                type: 'stdout',
                data: scrollbackResult.text,
                timestamp: scrollbackResult.timestamp,
              }]
            : [],
          text: scrollbackResult.text,
        };
      }

      const fetchedOutputs = sessionManager.getPanelOutputs(panel.id, limit + 1);
      const hasMore = fetchedOutputs.length > limit;
      const outputs = hasMore ? fetchedOutputs.slice(fetchedOutputs.length - limit) : fetchedOutputs;
      const records = outputs.map(outputToRecord);

      return {
        ok: true,
        panelId: panel.id,
        paneId: panel.sessionId,
        limit,
        returnedCount: records.length,
        hasMore,
        outputs: records,
        text: outputs.map(outputToText).join(''),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      resultCount: result.outputs.length,
      limit: result.limit,
    }));
  });

  commandRegistry.register('runpane:panels:input', async (request: unknown): Promise<RunpanePanelInputResult> => {
    return withRunpaneAction(services, 'panels:input', {}, () => {
      const normalized = parsePanelInputRequest(request);
      const panel = resolvePanel(normalized.panelId);

      if (panel.type !== 'terminal') {
        throw new Error(`Panel ${panel.id} is a ${panel.type} panel, not a terminal panel`);
      }
      if (!terminalPanelManager.isTerminalInitialized(panel.id)) {
        throw new Error(`Terminal panel ${panel.id} is not initialized`);
      }

      terminalPanelManager.writeToTerminal(panel.id, normalized.input);

      return {
        ok: true,
        panelId: panel.id,
        paneId: panel.sessionId,
        inputBytes: Buffer.byteLength(normalized.input, 'utf8'),
        sentAt: new Date().toISOString(),
        nextCommand: panelOutputCommand(panel.id),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      inputBytes: result.inputBytes,
    }));
  });

  commandRegistry.register('runpane:panels:screen', async (request: unknown): Promise<RunpanePanelScreenResult> => {
    return withRunpaneAction(services, 'panels:screen', {}, () => {
      const normalized = parsePanelScreenRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      return buildPanelScreenResult(panel, normalized.limit ?? DEFAULT_PANEL_SCREEN_LIMIT);
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      limit: result.limit,
      resultCount: result.returnedLineCount,
    }));
  });

  commandRegistry.register('runpane:panels:submit', async (request: unknown): Promise<RunpanePanelSubmitResult> => {
    return withRunpaneAction(services, 'panels:submit', {}, () => {
      const normalized = parsePanelSubmitRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      if (!terminalPanelManager.isTerminalInitialized(panel.id)) {
        throw new Error(`Terminal panel ${panel.id} is not initialized`);
      }

      const input = ensureSubmitEnter(normalized.input);
      terminalPanelManager.writeToTerminal(panel.id, input);

      return {
        ok: true,
        panelId: panel.id,
        paneId: panel.sessionId,
        inputBytes: Buffer.byteLength(input, 'utf8'),
        enter: 'cr',
        sentAt: new Date().toISOString(),
        nextCommand: panelWaitCommand(panel.id),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      inputBytes: result.inputBytes,
    }));
  });

  commandRegistry.register('runpane:panels:wait', async (request: unknown): Promise<RunpanePanelWaitResult> => {
    return withRunpaneAction(services, 'panels:wait', {}, async () => {
      const normalized = parsePanelWaitRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      return waitForPanel(panel, normalized);
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      ok: result.ok,
      resultCount: result.matched ? 1 : 0,
      condition: result.condition,
      timedOut: result.timedOut,
    }));
  });

  commandRegistry.register('runpane:agents:doctor', async (request: unknown): Promise<RunpaneAgentDoctorResult> => {
    return withRunpaneAction(services, 'agents:doctor', {}, async () => {
      const normalized = parseAgentDoctorRequest(request);
      const repo = normalized.repo
        ? resolveRepoSelector(databaseService.getAllProjects(), normalized.repo)
        : resolveActiveProject(databaseService.getAllProjects());
      return runAgentDoctor(services, repo, normalized.agent);
    }, result => ({
      repoId: result.repo?.id,
      ok: result.ok,
      resultCount: result.checks.length,
      available: result.available,
      environment: result.environment,
    }));
  });
}

export function runpaneDaemonChannels(): readonly string[] {
  return RUNPANE_CHANNELS;
}

function projectToRepoSummary(project: Project, sessionCount: number): RunpaneRepoSummary {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    active: Boolean(project.active),
    environment: new PathResolver(project).environment,
    sessionCount,
  };
}

function sessionToPaneSummary(session: Session, project: Project) {
  return {
    id: session.id,
    paneId: session.id,
    name: session.name,
    status: session.status,
    worktreePath: session.worktreePath,
    repoId: project.id,
    repoName: project.name,
    panelCount: panelManager.getPanelsForSession(session.id).length,
    createdAt: toIsoString(session.createdAt),
    lastActivity: toIsoString(session.lastActivity),
    archived: session.archived || undefined,
  };
}

function panelToSummary(panel: ToolPanel) {
  const customState = isRecord(panel.state.customState) ? panel.state.customState : {};
  const agentType = typeof customState.agentType === 'string' && AGENT_IDS.has(customState.agentType)
    ? customState.agentType as RunpaneAgentId
    : undefined;
  const isCliPanel = typeof customState.isCliPanel === 'boolean' ? customState.isCliPanel : undefined;

  return {
    id: panel.id,
    panelId: panel.id,
    paneId: panel.sessionId,
    type: panel.type,
    title: panel.title,
    active: Boolean(panel.state.isActive),
    initialized: panel.type === 'terminal' ? terminalPanelManager.isTerminalInitialized(panel.id) : undefined,
    agentType,
    isCliPanel,
    position: typeof panel.metadata.position === 'number' ? panel.metadata.position : undefined,
    createdAt: toIsoString(panel.metadata.createdAt),
    lastActiveAt: toIsoString(panel.metadata.lastActiveAt),
  };
}

interface PaneCreateItemOptions {
  timeoutMs?: number;
  waitReady?: boolean;
  readyTimeoutMs?: number;
}

async function createPaneItem(
  services: AppServices,
  repo: Project,
  item: RunpanePaneCreateItem,
  index: number,
  options: PaneCreateItemOptions,
): Promise<RunpanePaneCreateResultItem> {
  const { sessionManager, taskQueue } = services;
  if (!taskQueue) {
    throw new Error('Task queue not initialized');
  }

  try {
    const tool = resolveToolSpec(item.tool);
    const sessionResult = await taskQueue.createSessionAndWait({
      prompt: item.sessionPrompt ?? '',
      worktreeTemplate: item.worktreeName ?? item.name,
      projectId: repo.id,
      baseBranch: item.baseBranch,
      toolType: 'none',
    }, { timeoutMs: options.timeoutMs });

    const session = sessionManager.getSession(sessionResult.sessionId);
    if (!session) {
      throw new Error(`Created session ${sessionResult.sessionId} was not found`);
    }

    const initialState: TerminalPanelState = {
      initialCommand: tool.command,
      initialInput: tool.initialInput,
      agentType: tool.agent,
      isCliPanel: Boolean(tool.agent),
    };

    const panel = await panelManager.createPanel({
      sessionId: session.id,
      type: 'terminal',
      title: tool.title,
      initialState,
    });

    const context = sessionManager.getProjectContext(session.id);
    await terminalPanelManager.initializeTerminal(
      panel,
      session.worktreePath,
      context?.commandRunner.wslContext ?? null,
    );

    const readiness = options.waitReady
      ? toPaneReadiness(await waitForPanel(panel, {
        panelId: panel.id,
        condition: 'ready',
        timeoutMs: options.readyTimeoutMs ?? DEFAULT_PANEL_WAIT_TIMEOUT_MS,
        intervalMs: DEFAULT_PANEL_WAIT_INTERVAL_MS,
      }))
      : undefined;

    return {
      ok: true,
      index,
      name: item.name,
      sessionId: session.id,
      paneId: session.id,
      panelId: panel.id,
      worktreePath: session.worktreePath,
      nextCommand: readiness?.nextCommand ?? panelOutputCommand(panel.id),
      tool: describeTool(tool),
      readiness,
    };
  } catch (error) {
    return createFailureItem(index, item, error);
  }
}

function isPaneCreateItemSuccessful(item: RunpanePaneCreateResultItem): boolean {
  return item.ok && (!item.readiness || item.readiness.ok);
}

function toPaneReadiness(result: RunpanePanelWaitResult): RunpanePaneReadiness {
  return {
    ok: result.ok,
    condition: result.condition,
    matched: result.matched,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    state: result.state,
    blocked: result.blocked,
    nextCommand: result.nextCommand,
  };
}

async function mapSequentially<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  for (let index = 0; index < items.length; index++) {
    results[index] = await worker(items[index], index);
  }

  return results;
}

function resolveTerminalPanel(panelId: string): ToolPanel {
  const panel = resolvePanel(panelId);
  if (panel.type !== 'terminal') {
    throw new Error(`Panel ${panel.id} is a ${panel.type} panel, not a terminal panel`);
  }
  return panel;
}

function buildPanelScreenResult(panel: ToolPanel, limit: number): RunpanePanelScreenResult {
  const liveSnapshot = terminalPanelManager.getTerminalSnapshot(panel.id);
  const customState = getTerminalCustomState(panel);
  const state = panelStateSummary(panel, liveSnapshot, customState);
  const { source, rawText } = selectPanelScreenText(liveSnapshot, customState);
  const bounded = boundSanitizedLines(rawText, limit);

  return {
    ok: true,
    panelId: panel.id,
    paneId: panel.sessionId,
    source,
    limit,
    returnedLineCount: bounded.returnedLineCount,
    hasMore: bounded.hasMore,
    text: bounded.text,
    state,
    nextCommand: bounded.hasMore ? panelOutputCommand(panel.id) : panelWaitCommand(panel.id),
  };
}

function selectPanelScreenText(
  snapshot: TerminalPanelSnapshot | null,
  customState: TerminalPanelState,
): { source: RunpanePanelScreenSource; rawText: string } {
  if (snapshot) {
    if (snapshot.isAlternateScreen && snapshot.alternateScreenBuffer) {
      return { source: 'alternateScreen', rawText: snapshot.alternateScreenBuffer };
    }
    if (snapshot.scrollbackBuffer) {
      return { source: 'scrollback', rawText: snapshot.scrollbackBuffer };
    }
    return { source: 'empty', rawText: '' };
  }

  const persistedAlternate = customState.alternateScreenBuffer;
  if (customState.isAlternateScreen && persistedAlternate) {
    return { source: 'persistedOutput', rawText: persistedAlternate };
  }

  const persistedScrollback = normalizeScrollbackBuffer(customState.scrollbackBuffer);
  if (persistedScrollback) {
    return { source: 'persistedOutput', rawText: persistedScrollback };
  }

  return { source: 'empty', rawText: '' };
}

function panelStateSummary(
  panel: ToolPanel,
  snapshot: TerminalPanelSnapshot | null,
  customState: TerminalPanelState = getTerminalCustomState(panel),
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
  };
}

function getTerminalCustomState(panel: ToolPanel): TerminalPanelState {
  return (isRecord(panel.state.customState) ? panel.state.customState : {}) as TerminalPanelState;
}

function normalizeScrollbackBuffer(value: TerminalPanelState['scrollbackBuffer']): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join('\n');
  }
  return '';
}

function boundSanitizedLines(rawText: string, limit: number): { text: string; hasMore: boolean; returnedLineCount: number } {
  const stripped = sanitizeTerminalOutput(rawText);
  if (!stripped) {
    return { text: '', hasMore: false, returnedLineCount: 0 };
  }

  const allLines = stripped.split('\n');
  const hasMore = allLines.length > limit;
  const lines = hasMore ? allLines.slice(-limit) : allLines;
  return {
    text: lines.join('\n'),
    hasMore,
    returnedLineCount: lines.length,
  };
}

async function waitForPanel(panel: ToolPanel, request: RunpanePanelWaitRequest): Promise<RunpanePanelWaitResult> {
  const startedAt = Date.now();
  const timeoutMs = request.timeoutMs ?? DEFAULT_PANEL_WAIT_TIMEOUT_MS;
  const intervalMs = request.intervalMs ?? DEFAULT_PANEL_WAIT_INTERVAL_MS;
  let lastScreen = buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
  let condition = request.condition ?? defaultWaitCondition(lastScreen.state);

  while (Date.now() - startedAt <= timeoutMs) {
    lastScreen = buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
    condition = request.condition ?? defaultWaitCondition(lastScreen.state);
    const blocked = detectPanelBlocker(lastScreen.text, lastScreen.state.agentType, panel.id);
    const matched = isWaitConditionMatched(condition, lastScreen, request.contains, blocked);

    if (matched) {
      return panelWaitResult(panel, condition, true, false, startedAt, lastScreen);
    }
    if (blocked && condition !== 'text') {
      return panelWaitResult(panel, condition, false, false, startedAt, lastScreen, blocked);
    }

    await sleep(Math.min(intervalMs, Math.max(timeoutMs - (Date.now() - startedAt), 0)));
  }

  return panelWaitResult(panel, condition, false, true, startedAt, lastScreen);
}

function defaultWaitCondition(state: RunpanePanelStateSummary): RunpanePanelWaitCondition {
  return state.isCliPanel ? 'ready' : 'idle';
}

function isWaitConditionMatched(
  condition: RunpanePanelWaitCondition,
  screen: RunpanePanelScreenResult,
  contains: string | undefined,
  blocked?: RunpanePanelBlockedState,
): boolean {
  switch (condition) {
    case 'initialized':
      return screen.state.initialized;
    case 'ready':
      if (blocked) return false;
      return screen.state.initialized && (screen.state.isCliPanel ? screen.state.isCliReady === true : true);
    case 'idle':
      return screen.state.initialized && screen.state.activityStatus === 'idle';
    case 'text':
      return Boolean(contains && screen.text.includes(contains));
  }
}

function panelWaitResult(
  panel: ToolPanel,
  condition: RunpanePanelWaitCondition,
  matched: boolean,
  timedOut: boolean,
  startedAt: number,
  screen: RunpanePanelScreenResult,
  blocked?: RunpanePanelBlockedState,
): RunpanePanelWaitResult {
  return {
    ok: matched && !timedOut && !blocked,
    panelId: panel.id,
    paneId: panel.sessionId,
    condition,
    matched,
    timedOut,
    elapsedMs: Date.now() - startedAt,
    state: screen.state,
    blocked,
    screen: {
      source: screen.source,
      text: screen.text,
      hasMore: screen.hasMore,
    },
    nextCommand: blocked?.suggestedCommand ?? (matched ? panelScreenCommand(panel.id) : panelWaitCommand(panel.id, condition)),
  };
}

function detectPanelBlocker(
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
      suggestedCommand: panelScreenCommand(panelId),
    };
  }

  return undefined;
}

function ensureSubmitEnter(input: string): string {
  if (input.endsWith('\r')) {
    return input;
  }
  if (input.endsWith('\r\n')) {
    return `${input.slice(0, -2)}\r`;
  }
  if (input.endsWith('\n')) {
    return `${input.slice(0, -1)}\r`;
  }
  return `${input}\r`;
}

async function runAgentDoctor(
  services: AppServices,
  repo: Project,
  agent: RunpaneAgentId,
): Promise<RunpaneAgentDoctorResult> {
  const context = services.sessionManager.getProjectContextByProjectId(repo.id);
  const repoSummary = projectToRepoSummary(repo, services.sessionManager.getSessionsForProject(repo.id).length);
  const environment = new PathResolver(repo).environment;
  const command = AGENT_TEMPLATES[agent].command;
  const executable = agentCommandExecutable(command);
  const checks: RunpaneAgentDoctorResult['checks'] = [];
  const warnings: string[] = [];

  if (!context) {
    checks.push({
      name: 'repo-context',
      ok: false,
      message: `Could not create Pane execution context for repo ${repo.id}.`,
    });
    return {
      ok: false,
      agent,
      command,
      repo: repoSummary,
      environment,
      available: false,
      checks,
      warnings,
    };
  }

  const lookupCommand = environment === 'windows' ? `where ${executable}` : `command -v ${executable}`;
  let executablePath: string | undefined;
  let version: string | undefined;

  try {
    const result = await context.commandRunner.execAsync(lookupCommand, repo.path, {
      timeout: 5_000,
      silent: true,
    });
    executablePath = firstNonEmptyLine(result.stdout);
    checks.push({
      name: 'executable',
      ok: Boolean(executablePath),
      message: executablePath ? `Found ${executable} at ${executablePath}.` : `${executable} was not found on PATH.`,
    });
  } catch (error) {
    checks.push({
      name: 'executable',
      ok: false,
      message: commandErrorMessage(error, `${executable} was not found on PATH.`),
    });
  }

  if (executablePath) {
    try {
      const result = await context.commandRunner.execAsync(`${executable} --version`, repo.path, {
        timeout: 5_000,
        silent: true,
      });
      version = firstNonEmptyLine(result.stdout) || firstNonEmptyLine(result.stderr);
      checks.push({
        name: 'version',
        ok: Boolean(version),
        message: version ? version : `${executable} did not print a version.`,
      });
    } catch (error) {
      warnings.push(commandErrorMessage(error, `${executable} --version failed.`));
      checks.push({
        name: 'version',
        ok: false,
        message: `${executable} is on PATH, but --version failed.`,
      });
    }
  }

  if (environment === 'wsl' && !executablePath) {
    warnings.push(`Repo ${repo.name} is a WSL repo; install ${executable} inside the WSL distro Pane uses, not only on Windows.`);
  }

  const available = Boolean(executablePath);
  return {
    ok: available,
    agent,
    command,
    repo: repoSummary,
    environment,
    available,
    executablePath,
    version,
    checks,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function outputToRecord(output: SessionOutput): RunpanePanelOutputRecord {
  return {
    type: output.type,
    data: output.data,
    timestamp: requireIsoString(output.timestamp, 'Panel output timestamp'),
  };
}

function outputToText(output: SessionOutput): string {
  if (typeof output.data === 'string') {
    return output.data;
  }

  try {
    return `${JSON.stringify(output.data)}\n`;
  } catch {
    return `${String(output.data)}\n`;
  }
}

function panelScrollbackOutput(panel: ToolPanel, limit: number): { text: string; hasMore: boolean; timestamp: string } | null {
  const rawScrollback = getPanelScrollback(panel);
  if (!rawScrollback) {
    return null;
  }

  const stripped = sanitizeTerminalOutput(rawScrollback);
  if (!stripped) {
    return null;
  }

  const allLines = stripped.split('\n');
  const hasMore = allLines.length > limit;
  const text = allLines.slice(-limit).join('\n');
  const timestamp = toIsoString(panel.metadata.lastActiveAt) ?? new Date().toISOString();

  return { text, hasMore, timestamp };
}

function getPanelScrollback(panel: ToolPanel): string | null {
  const liveScrollback = terminalPanelManager.getTerminalScrollback(panel.id);
  if (liveScrollback !== null) {
    return liveScrollback;
  }

  const customState = panel.state.customState;
  if (!isRecord(customState) || !('scrollbackBuffer' in customState)) {
    return null;
  }

  const persisted = normalizeScrollbackBuffer((customState as TerminalPanelState).scrollbackBuffer);
  if (persisted) return persisted;

  return null;
}

function panelOutputCommand(panelId: string): string {
  return `runpane panels output --panel ${panelId} --limit ${DEFAULT_PANEL_OUTPUT_LIMIT} --json`;
}

function panelScreenCommand(panelId: string): string {
  return `runpane panels screen --panel ${panelId} --limit ${DEFAULT_PANEL_SCREEN_LIMIT} --json`;
}

function panelWaitCommand(panelId: string, condition: RunpanePanelWaitCondition = 'ready'): string {
  return `runpane panels wait --panel ${panelId} --for ${condition} --timeout-ms ${DEFAULT_PANEL_WAIT_TIMEOUT_MS} --json`;
}

function parsePaneListRequest(value: unknown): RunpanePaneListRequest {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('Pane list request must be an object');
  }
  if (value.repo === undefined || value.repo === null || value.repo === '') {
    return {};
  }

  return {
    repo: parseRepoSelector(value.repo),
  };
}

function parsePaneCreateRequest(value: unknown): RunpanePaneCreateRequest {
  if (!isRecord(value)) {
    throw new Error('Pane create request must be an object');
  }

  const repo = parseRepoSelector(value.repo);
  const panesValue = value.panes;
  if (!Array.isArray(panesValue) || panesValue.length === 0) {
    throw new Error('Pane create request must include at least one pane');
  }

  return {
    repo,
    panes: panesValue.map(parsePaneCreateItem),
    dryRun: typeof value.dryRun === 'boolean' ? value.dryRun : undefined,
    timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined,
    waitReady: typeof value.waitReady === 'boolean' ? value.waitReady : undefined,
    readyTimeoutMs: parsePositiveInteger(value.readyTimeoutMs, 'readyTimeoutMs'),
    concurrency: parsePositiveInteger(value.concurrency, 'concurrency'),
  };
}

function parsePanelListRequest(value: unknown): RunpanePanelListRequest {
  if (!isRecord(value)) {
    throw new Error('Panel list request must be an object');
  }

  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Panel list request must include paneId');
  }

  return { paneId };
}

function parsePanelOutputRequest(value: unknown): RunpanePanelOutputRequest {
  if (!isRecord(value)) {
    throw new Error('Panel output request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel output request must include panelId');
  }

  return {
    panelId,
    limit: parsePositiveInteger(value.limit, 'limit'),
  };
}

function parsePanelInputRequest(value: unknown): RunpanePanelInputRequest {
  if (!isRecord(value)) {
    throw new Error('Panel input request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel input request must include panelId');
  }
  if (typeof value.input !== 'string') {
    throw new Error('Panel input request must include input');
  }

  return {
    panelId,
    input: value.input,
  };
}

function parsePanelScreenRequest(value: unknown): RunpanePanelScreenRequest {
  if (!isRecord(value)) {
    throw new Error('Panel screen request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel screen request must include panelId');
  }

  return {
    panelId,
    limit: parsePositiveInteger(value.limit, 'limit'),
  };
}

function parsePanelSubmitRequest(value: unknown): RunpanePanelSubmitRequest {
  if (!isRecord(value)) {
    throw new Error('Panel submit request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel submit request must include panelId');
  }
  if (typeof value.input !== 'string') {
    throw new Error('Panel submit request must include input');
  }

  return {
    panelId,
    input: value.input,
  };
}

function parsePanelWaitRequest(value: unknown): RunpanePanelWaitRequest {
  if (!isRecord(value)) {
    throw new Error('Panel wait request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel wait request must include panelId');
  }

  const contains = optionalString(value.contains);
  const condition = parseWaitCondition(value.condition, contains);
  if (condition === 'text' && (!contains || contains.length === 0)) {
    throw new Error('Panel wait request with condition "text" must include contains');
  }

  return {
    panelId,
    condition,
    contains,
    timeoutMs: parsePositiveInteger(value.timeoutMs, 'timeoutMs'),
    intervalMs: parsePositiveInteger(value.intervalMs, 'intervalMs'),
  };
}

function parseAgentDoctorRequest(value: unknown): RunpaneAgentDoctorRequest {
  if (!isRecord(value)) {
    throw new Error('Agent doctor request must be an object');
  }
  if (typeof value.agent !== 'string' || !AGENT_IDS.has(value.agent)) {
    throw new Error(`Agent doctor request must include agent: ${[...AGENT_IDS].join(', ')}`);
  }

  return {
    agent: value.agent as RunpaneAgentId,
    repo: value.repo === undefined || value.repo === null || value.repo === ''
      ? undefined
      : parseRepoSelector(value.repo),
  };
}

function parseWaitCondition(value: unknown, contains?: string): RunpanePanelWaitCondition | undefined {
  if (value === undefined || value === null || value === '') {
    return contains ? 'text' : undefined;
  }
  if (value === 'initialized' || value === 'ready' || value === 'idle' || value === 'text') {
    return value;
  }
  throw new Error('Panel wait condition must be one of: initialized, ready, idle, text');
}

function parseRepoAddRequest(value: unknown): Required<Pick<RunpaneRepoAddRequest, 'path' | 'name'>> & Pick<RunpaneRepoAddRequest, 'dryRun'> {
  if (!isRecord(value)) {
    throw new Error('Repo add request must be an object');
  }

  if (typeof value.path !== 'string' || value.path.trim().length === 0) {
    throw new Error('Repo add request must include a path');
  }

  const repoPath = path.resolve(value.path);
  const providedName = optionalString(value.name)?.trim();
  const defaultName = path.basename(repoPath) || repoPath;

  return {
    path: repoPath,
    name: providedName && providedName.length > 0 ? providedName : defaultName,
    dryRun: typeof value.dryRun === 'boolean' ? value.dryRun : undefined,
  };
}

function resolvePane(sessionManager: AppServices['sessionManager'], paneId: string): Session {
  const session = sessionManager.getSession(paneId);
  if (!session) {
    throw new Error(`No Pane pane found with id ${paneId}`);
  }
  return session;
}

function resolvePanel(panelId: string): ToolPanel {
  const panel = panelManager.getPanel(panelId);
  if (!panel) {
    throw new Error(`No Pane panel found with id ${panelId}`);
  }
  return panel;
}

function parsePaneCreateItem(value: unknown, index: number): RunpanePaneCreateItem {
  if (!isRecord(value)) {
    throw new Error(`Pane create item ${index} must be an object`);
  }

  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error(`Pane create item ${index} must include a name`);
  }

  return {
    name: value.name,
    worktreeName: optionalString(value.worktreeName),
    baseBranch: optionalString(value.baseBranch),
    sessionPrompt: optionalString(value.sessionPrompt),
    tool: parseToolSpec(value.tool, index),
  };
}

function validateRepositoryPath(repoPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Repo path must be a directory: ${repoPath}`);
  }

  try {
    const output = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (output !== 'true') {
      throw new Error('not inside work tree');
    }
  } catch {
    throw new Error(`Repo path must be an existing git repository: ${repoPath}`);
  }
}

function parseToolSpec(value: unknown, index: number): RunpaneToolSpec {
  if (!isRecord(value)) {
    throw new Error(`Pane create item ${index} must include a tool object`);
  }

  if (typeof value.agent === 'string') {
    if (!AGENT_IDS.has(value.agent)) {
      throw new Error(`Unsupported agent "${value.agent}" in pane create item ${index}`);
    }
    return {
      agent: value.agent as RunpaneAgentId,
      title: optionalString(value.title),
      initialInput: optionalString(value.initialInput),
    };
  }

  if (typeof value.command === 'string' && value.command.trim().length > 0) {
    return {
      command: value.command,
      title: optionalString(value.title),
      initialInput: optionalString(value.initialInput),
    };
  }

  throw new Error(`Pane create item ${index} tool must include agent or command`);
}

function parseRepoSelector(value: unknown): RunpaneRepoSelector {
  if (typeof value === 'string') {
    return value;
  }

  if (!isRecord(value)) {
    throw new Error('Pane create request must include a repo selector');
  }

  if (typeof value.id === 'number') {
    return { id: value.id };
  }
  if (typeof value.path === 'string') {
    return { path: value.path };
  }
  if (typeof value.name === 'string') {
    return { name: value.name };
  }
  if (value.active === true) {
    return { active: true };
  }

  throw new Error('Repo selector must include id, path, name, active, or a string selector');
}

function resolveRepoSelector(projects: Project[], selector: RunpaneRepoSelector): Project {
  if (typeof selector === 'string') {
    if (selector === 'active' || selector === 'default') {
      return resolveActiveProject(projects);
    }

    if (/^\d+$/.test(selector)) {
      const byId = projects.find(project => project.id === Number(selector));
      if (byId) {
        return byId;
      }
    }

    const byPath = resolveProjectByPath(projects, selector);
    if (byPath) {
      return byPath;
    }

    return resolveProjectByName(projects, selector);
  }

  if ('id' in selector) {
    const project = projects.find(candidate => candidate.id === selector.id);
    if (!project) {
      throw new Error(`No Pane repo found with id ${selector.id}`);
    }
    return project;
  }

  if ('path' in selector) {
    const project = resolveProjectByPath(projects, selector.path);
    if (!project) {
      throw new Error(`No Pane repo found at path ${selector.path}`);
    }
    return project;
  }

  if ('name' in selector) {
    return resolveProjectByName(projects, selector.name);
  }

  return resolveActiveProject(projects);
}

function resolveActiveProject(projects: Project[]): Project {
  const active = projects.find(project => Boolean(project.active));
  if (!active) {
    throw new Error('No active Pane repo found');
  }
  return active;
}

function resolveProjectByPath(projects: Project[], selectorPath: string): Project | undefined {
  const normalized = path.resolve(selectorPath);
  return projects.find(project => project.path === selectorPath || path.resolve(project.path) === normalized);
}

function resolveProjectByName(projects: Project[], selectorName: string): Project {
  const matches = projects.filter(project => project.name.toLowerCase() === selectorName.toLowerCase());
  if (matches.length === 0) {
    throw new Error(`No Pane repo found named "${selectorName}"`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple Pane repos are named "${selectorName}". Use --repo-id or an exact path.`);
  }
  return matches[0];
}

function resolveToolSpec(tool: RunpaneToolSpec): RunpaneResolvedTool {
  if ('agent' in tool) {
    const template = AGENT_TEMPLATES[tool.agent];
    return {
      title: tool.title ?? template.title,
      command: template.command,
      agent: tool.agent,
      initialInput: tool.initialInput,
    };
  }

  return {
    title: tool.title ?? 'Terminal',
    command: tool.command,
    initialInput: tool.initialInput,
  };
}

function describeTool(tool: RunpaneResolvedTool): { title: string; command: string; agent?: RunpaneAgentId } {
  return {
    title: tool.title,
    command: tool.command,
    agent: tool.agent,
  };
}

function createFailureItem(index: number, item: RunpanePaneCreateItem, error: unknown): RunpanePaneCreateFailureItem {
  return {
    ok: false,
    index,
    name: item.name,
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: 'ERR_RUNPANE_PANE_CREATE_FAILED',
    },
  };
}

function parsePositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function toIsoString(value: Date | string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function requireIsoString(value: Date | string | undefined, label: string): string {
  const isoString = toIsoString(value);
  if (!isoString) {
    throw new Error(`${label} is invalid`);
  }
  return isoString;
}

interface RunpaneActionMetadata {
  repoId?: number;
  paneId?: string;
  panelId?: string;
  resultCount?: number;
  inputBytes?: number;
  limit?: number;
  ok?: boolean;
  condition?: string;
  timedOut?: boolean;
  available?: boolean;
  environment?: string;
}

async function withRunpaneAction<T>(
  services: AppServices,
  action: string,
  metadata: RunpaneActionMetadata,
  handler: () => Promise<T> | T,
  resultMetadata?: (result: T) => RunpaneActionMetadata,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await handler();
    const commandOk = isRecord(result) && typeof result.ok === 'boolean' ? result.ok : true;
    trackRunpaneAction(services, action, 'success', Date.now() - startedAt, {
      ...metadata,
      ok: commandOk,
      ...(resultMetadata ? resultMetadata(result) : {}),
    });
    return result;
  } catch (error) {
    trackRunpaneAction(services, action, 'failure', Date.now() - startedAt, {
      ...metadata,
      ok: false,
    }, error);
    throw error;
  }
}

function trackRunpaneAction(
  services: AppServices,
  action: string,
  status: 'success' | 'failure',
  durationMs: number,
  metadata: RunpaneActionMetadata,
  error?: unknown,
): void {
  const analyticsManager = services.analyticsManager;
  const paneIdHash = metadata.paneId && analyticsManager?.hashSessionId(metadata.paneId);
  const panelIdHash = metadata.panelId && analyticsManager?.hashSessionId(metadata.panelId);
  const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
  const errorType = error instanceof Error ? error.name : error ? 'Error' : undefined;

  analyticsManager?.track('runpane_local_control', {
    action,
    status,
    command_ok: metadata.ok,
    duration_ms: durationMs,
    repo_id: metadata.repoId,
    pane_id_hash: paneIdHash,
    panel_id_hash: panelIdHash,
    result_count: metadata.resultCount,
    input_bytes: metadata.inputBytes,
    limit: metadata.limit,
    condition: metadata.condition,
    timed_out: metadata.timedOut,
    available: metadata.available,
    environment: metadata.environment,
    error_type: errorType,
  });

  const logPayload = {
    action,
    status,
    commandOk: metadata.ok,
    durationMs,
    repoId: metadata.repoId,
    paneIdHash,
    panelIdHash,
    resultCount: metadata.resultCount,
    inputBytes: metadata.inputBytes,
    limit: metadata.limit,
    condition: metadata.condition,
    timedOut: metadata.timedOut,
    available: metadata.available,
    environment: metadata.environment,
    error: errorMessage,
  };

  if (status === 'success') {
    console.log('[Runpane] Local control action completed', logPayload);
  } else {
    console.warn('[Runpane] Local control action failed', logPayload);
  }
}

function agentCommandExecutable(command: string): string {
  const executable = command.trim().split(/\s+/)[0];
  if (!executable || !/^[A-Za-z0-9._-]+$/.test(executable)) {
    throw new Error(`Unsupported agent command executable: ${command}`);
  }
  return executable;
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
  return value
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
}

function commandErrorMessage(error: unknown, fallback: string): string {
  if (isRecord(error)) {
    const stderr = firstNonEmptyLine(typeof error.stderr === 'string' ? error.stderr : undefined);
    const stdout = firstNonEmptyLine(typeof error.stdout === 'string' ? error.stdout : undefined);
    if (stderr) return stderr;
    if (stdout) return stdout;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
