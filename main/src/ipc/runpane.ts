import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PathResolver } from '../utils/pathResolver';
import { sanitizeTerminalOutput } from '../utils/terminalOutputSanitizer';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { ensureProjectAgentContext } from '../services/agentContextManager';
import type { Project } from '../database/models';
import type { Session, SessionOutput } from '../types/session';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import type {
  RunpaneAgentId,
  RunpanePaneListRequest,
  RunpanePaneListResult,
  RunpanePaneCreateFailureItem,
  RunpanePaneCreateItem,
  RunpanePaneCreateRequest,
  RunpanePaneCreateResult,
  RunpanePaneCreateResultItem,
  RunpanePanelInputRequest,
  RunpanePanelInputResult,
  RunpanePanelListRequest,
  RunpanePanelListResult,
  RunpanePanelOutputRecord,
  RunpanePanelOutputRequest,
  RunpanePanelOutputResult,
  RunpaneRepoAddRequest,
  RunpaneRepoAddResult,
  RunpaneRepoListResult,
  RunpaneRepoSelector,
  RunpaneRepoSummary,
  RunpaneResolvedTool,
  RunpaneToolSpec,
} from '../../../shared/types/runpaneOrchestration';

const RUNPANE_CHANNELS = [
  'runpane:repos:list',
  'runpane:repos:add',
  'runpane:panes:list',
  'runpane:panes:create',
  'runpane:panels:list',
  'runpane:panels:output',
  'runpane:panels:input',
] as const;

const AGENT_TEMPLATES = RUNPANE_CONTRACT.agentTemplates;
const AGENT_IDS = new Set<string>(RUNPANE_CONTRACT.enums.agents);
const DEFAULT_PANEL_OUTPUT_LIMIT = 200;

export function registerRunpaneHandlers(
  _ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const { databaseService, sessionManager, taskQueue, configManager } = services;

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

      const items: RunpanePaneCreateResultItem[] = [];
      for (let index = 0; index < normalized.panes.length; index++) {
        const item = normalized.panes[index];
        try {
          const tool = resolveToolSpec(item.tool);
          const sessionResult = await taskQueue.createSessionAndWait({
            prompt: item.sessionPrompt ?? '',
            worktreeTemplate: item.worktreeName ?? item.name,
            projectId: repo.id,
            baseBranch: item.baseBranch,
            toolType: 'none',
          }, { timeoutMs: normalized.timeoutMs });

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

          items.push({
            ok: true,
            index,
            name: item.name,
            sessionId: session.id,
            paneId: session.id,
            panelId: panel.id,
            worktreePath: session.worktreePath,
            nextCommand: panelOutputCommand(panel.id),
            tool: describeTool(tool),
          });
        } catch (error) {
          items.push(createFailureItem(index, item, error));
        }
      }

      return {
        ok: items.every(item => item.ok),
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

  const persisted = (customState as TerminalPanelState).scrollbackBuffer;
  if (typeof persisted === 'string') {
    return persisted;
  }
  if (Array.isArray(persisted)) {
    return persisted.join('\n');
  }

  return null;
}

function panelOutputCommand(panelId: string): string {
  return `runpane panels output --panel ${panelId} --limit ${DEFAULT_PANEL_OUTPUT_LIMIT} --json`;
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
    error: errorMessage,
  };

  if (status === 'success') {
    console.log('[Runpane] Local control action completed', logPayload);
  } else {
    console.warn('[Runpane] Local control action failed', logPayload);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
