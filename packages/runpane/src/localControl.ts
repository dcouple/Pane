import fs from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { invokeDaemon } from './daemonClient';
import { RUNPANE_CONTRACT } from './generated/contract';
import type { ParsedArgs, RunpaneAgent } from './commands';

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
}

interface PaneCreateItem {
  name: string;
  worktreeName?: string;
  baseBranch?: string;
  sessionPrompt?: string;
  tool: PaneToolSpec;
}

type PaneToolSpec =
  | { agent: RunpaneAgent; title?: string; initialInput?: string }
  | { command: string; title?: string; initialInput?: string };

interface PaneCreateResult {
  ok: boolean;
  repo: RepoSummary;
  items: Array<{
    ok: boolean;
    index: number;
    name?: string;
    sessionId?: string;
    panelId?: string;
    worktreePath?: string;
    error?: { message: string; code?: string };
  }>;
}

export async function runReposList(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon<RepoListResult>('runpane:repos:list', [], {
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

  const result = await invokeDaemon<RepoAddResult>('runpane:repos:add', [request], {
    paneDir: parsed.paneDir,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    printRepoAddResult(result);
  }

  return 0;
}

export async function runPanesCreate(parsed: ParsedArgs): Promise<number> {
  const request = await buildPaneCreateRequest(parsed);
  await confirmPaneCreate(parsed, request);

  const result = await invokeDaemon<PaneCreateResult>('runpane:panes:create', [request], {
    paneDir: parsed.paneDir,
    timeoutMs: (parsed.timeoutMs ?? 120_000) + 10_000,
  });

  if (parsed.json) {
    printJson(result);
  } else {
    printPaneCreateResult(result);
  }

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

async function buildPaneCreateRequest(parsed: ParsedArgs): Promise<PaneCreateRequest> {
  if (parsed.fromJson) {
    const payload = JSON.parse(readInputSource(parsed.fromJson)) as unknown;
    const request = parsePaneCreateRequestPayload(payload);
    if (parsed.dryRun) {
      request.dryRun = true;
    }
    if (parsed.timeoutMs !== undefined) {
      request.timeoutMs = parsed.timeoutMs;
    }
    return request;
  }

  if (!parsed.repo) {
    throw new Error('runpane panes create requires --repo unless --from-json is used.');
  }
  if (!parsed.name) {
    throw new Error('runpane panes create requires --name unless --from-json is used.');
  }

  const tool = await buildToolSpec(parsed);
  const request: PaneCreateRequest = {
    repo: parsed.repo,
    panes: [{
      name: parsed.name,
      worktreeName: parsed.worktreeName,
      baseBranch: parsed.baseBranch,
      tool,
    }],
    dryRun: parsed.dryRun || undefined,
    timeoutMs: parsed.timeoutMs,
  };

  return request;
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

async function buildToolSpec(parsed: ParsedArgs): Promise<PaneToolSpec> {
  if (parsed.agent && parsed.toolCommand) {
    throw new Error('Use either --agent or --tool-command, not both.');
  }

  const initialInput = resolveInitialInput(parsed);
  let agent = parsed.agent;

  if (!agent && !parsed.toolCommand) {
    if (!isInteractiveShell()) {
      throw new Error('runpane panes create requires --agent or --tool-command in non-interactive shells.');
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
    throw new Error('runpane panes create requires --agent or --tool-command.');
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
      if ((agents as readonly string[]).includes(answer)) {
        return answer as RunpaneAgent;
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

function printJson(value: unknown): void {
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

function printPaneCreateResult(result: PaneCreateResult): void {
  for (const item of result.items) {
    if (item.ok) {
      const worktree = item.worktreePath ? ` at ${item.worktreePath}` : '';
      console.log(`Created ${item.name ?? `pane ${item.index}`}: session ${item.sessionId ?? 'unknown'} panel ${item.panelId ?? 'unknown'}${worktree}`);
      continue;
    }
    console.error(`Failed ${item.name ?? `pane ${item.index}`}: ${item.error?.message ?? 'unknown error'}`);
  }
}

function isInteractiveShell(): boolean {
  return Boolean(input.isTTY && output.isTTY && !process.env.CI);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePaneCreateRequestPayload(value: unknown): PaneCreateRequest {
  if (!isRecord(value)) {
    throw new Error('--from-json payload must be an object.');
  }

  const repo = value.repo;
  const panes = value.panes;
  if (!isRepoSelector(repo)) {
    throw new Error('--from-json payload must include a valid repo selector.');
  }
  if (!Array.isArray(panes) || panes.length === 0) {
    throw new Error('--from-json payload must include at least one pane.');
  }

  return {
    repo,
    panes: panes as PaneCreateItem[],
    dryRun: typeof value.dryRun === 'boolean' ? value.dryRun : undefined,
    timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined,
  };
}

function isRepoSelector(value: unknown): value is PaneCreateRequest['repo'] {
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'number' ||
    typeof value.path === 'string' ||
    typeof value.name === 'string' ||
    value.active === true
  );
}
