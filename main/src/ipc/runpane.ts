import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PathResolver } from '../utils/pathResolver';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import type { Project } from '../database/models';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import type {
  RunpaneAgentId,
  RunpanePaneCreateFailureItem,
  RunpanePaneCreateItem,
  RunpanePaneCreateRequest,
  RunpanePaneCreateResult,
  RunpanePaneCreateResultItem,
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
  'runpane:panes:create',
] as const;

const AGENT_TEMPLATES = RUNPANE_CONTRACT.agentTemplates;
const AGENT_IDS = new Set<string>(RUNPANE_CONTRACT.enums.agents);

export function registerRunpaneHandlers(
  _ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const { databaseService, sessionManager, taskQueue } = services;

  commandRegistry.register('runpane:repos:list', async (): Promise<RunpaneRepoListResult> => {
    const repos = databaseService.getAllProjects().map((project) =>
      projectToRepoSummary(project, sessionManager.getSessionsForProject(project.id).length)
    );
    return { ok: true, repos };
  });

  commandRegistry.register('runpane:repos:add', async (request: unknown): Promise<RunpaneRepoAddResult> => {
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

    return {
      ok: true,
      created: true,
      repo: projectToRepoSummary(project, 0),
    };
  });

  commandRegistry.register('runpane:panes:create', async (request: unknown): Promise<RunpanePaneCreateResult> => {
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
