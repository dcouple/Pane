import fs from 'fs/promises';
import path from 'path';
import type { Project } from '../database/models';
import type { AppConfig } from '../types/config';
import { PathResolver } from '../utils/pathResolver';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';

export const PANE_AGENT_CONTEXT_START = '<!-- pane-agent-context:start -->';
export const PANE_AGENT_CONTEXT_END = '<!-- pane-agent-context:end -->';

const AGENTS_FILENAMES = ['AGENTS.md', 'agents.md'] as const;

export interface AgentContextWriteResult {
  changed: boolean;
  filePath?: string;
  skipped?: 'disabled' | 'missing';
  removed?: boolean;
}

export async function ensureProjectAgentContext(
  project: Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>,
  config: Pick<AppConfig, 'agentContext'>,
): Promise<AgentContextWriteResult> {
  const root = resolveProjectRoot(project);
  const enabled = config.agentContext?.managedAgentsMd !== false;

  if (!enabled) {
    return removeProjectAgentContext(root);
  }

  const filePath = await resolveAgentsFilePath(root);
  const existing = await readFileIfExists(filePath);
  const block = renderManagedAgentContextBlock();
  const next = upsertManagedBlock(existing ?? '', block);

  if (existing === next) {
    return { changed: false, filePath };
  }

  await fs.writeFile(filePath, next, 'utf8');
  return { changed: true, filePath };
}

export function renderManagedAgentContextBlock(): string {
  return [
    PANE_AGENT_CONTEXT_START,
    ...RUNPANE_CONTRACT.agentContext.managedBlock,
    PANE_AGENT_CONTEXT_END,
    ''
  ].join('\n');
}

export function upsertManagedBlock(existing: string, block: string = renderManagedAgentContextBlock()): string {
  const startIndex = existing.indexOf(PANE_AGENT_CONTEXT_START);
  const endIndex = existing.indexOf(PANE_AGENT_CONTEXT_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const afterEndIndex = consumeTrailingNewline(existing, endIndex + PANE_AGENT_CONTEXT_END.length);
    return `${existing.slice(0, startIndex)}${block}${existing.slice(afterEndIndex)}`;
  }

  if (existing.trim().length === 0) {
    return block;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}`;
}

export function removeManagedBlock(existing: string): string {
  const startIndex = existing.indexOf(PANE_AGENT_CONTEXT_START);
  const endIndex = existing.indexOf(PANE_AGENT_CONTEXT_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return existing;
  }

  const afterEndIndex = consumeTrailingNewline(existing, endIndex + PANE_AGENT_CONTEXT_END.length);
  const next = `${existing.slice(0, startIndex)}${existing.slice(afterEndIndex)}`;
  return next.trim().length === 0 ? '' : next;
}

async function removeProjectAgentContext(root: string): Promise<AgentContextWriteResult> {
  const filePath = await findExistingAgentsFile(root);
  if (!filePath) {
    return { changed: false, skipped: 'disabled' };
  }

  const existing = await readFileIfExists(filePath);
  if (existing === undefined) {
    return { changed: false, skipped: 'missing' };
  }

  const next = removeManagedBlock(existing);
  if (next === existing) {
    return { changed: false, filePath, skipped: 'disabled' };
  }

  if (next.length === 0) {
    await fs.rm(filePath, { force: true });
  } else {
    await fs.writeFile(filePath, next, 'utf8');
  }
  return { changed: true, filePath, removed: true };
}

async function resolveAgentsFilePath(root: string): Promise<string> {
  const existing = await findExistingAgentsFile(root);
  return existing ?? path.join(root, 'AGENTS.md');
}

async function findExistingAgentsFile(root: string): Promise<string | undefined> {
  for (const fileName of AGENTS_FILENAMES) {
    const filePath = path.join(root, fileName);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        return filePath;
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
  return undefined;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function resolveProjectRoot(project: Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>): string {
  return new PathResolver(project).toFileSystem(project.path);
}

function consumeTrailingNewline(value: string, index: number): number {
  if (value[index] === '\r' && value[index + 1] === '\n') {
    return index + 2;
  }
  if (value[index] === '\n') {
    return index + 1;
  }
  return index;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
