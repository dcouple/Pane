import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { posixJoin } from '../utils/wslUtils';
import type { CommandRunner } from '../utils/commandRunner';
import type { ProjectEnvironment } from '../utils/pathResolver';
import type { DetectedProjectConfig } from '../../../shared/types/projectConfig';

// Internal schema interfaces — NOT exported
interface PaneJsonSchema {
  scripts?: {
    setup?: string;
    run?: string;
    archive?: string;
  };
  runScriptMode?: 'concurrent' | 'nonconcurrent';
}

interface GitpodYmlSchema {
  tasks?: Array<{
    init?: string;
    command?: string;
  }>;
}

interface DevcontainerJsonSchema {
  postCreateCommand?: string | string[];
  postStartCommand?: string | string[];
}

function envJoin(environment: ProjectEnvironment, ...segments: string[]): string {
  if (environment === 'wsl') {
    return posixJoin(...segments);
  }
  return path.join(...segments);
}

async function fileExists(
  filePath: string,
  environment: ProjectEnvironment,
  commandRunner?: CommandRunner,
  cwd?: string,
): Promise<boolean> {
  try {
    if (environment === 'windows') {
      await fs.promises.access(filePath);
      return true;
    }
    if (!commandRunner) return false;
    await commandRunner.execAsync(`test -e "${filePath}"`, cwd || filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFile(
  filePath: string,
  environment: ProjectEnvironment,
  commandRunner?: CommandRunner,
  cwd?: string,
): Promise<string> {
  if (environment === 'windows') {
    return fs.promises.readFile(filePath, 'utf-8');
  }
  if (!commandRunner) throw new Error('CommandRunner required for non-Windows environments');
  const { stdout } = await commandRunner.execAsync(`cat "${filePath}"`, cwd || filePath);
  return stdout;
}

type ConfigParser = (content: string, source: string) => DetectedProjectConfig | null;

const CONFIG_FILES: Array<{ file: string; parser: ConfigParser }> = [
  { file: 'pane.json', parser: parsePaneJson },
  { file: 'conductor.json', parser: parseConductorJson },
  { file: '.gitpod.yml', parser: parseGitpodYml },
  { file: '.devcontainer/devcontainer.json', parser: parseDevcontainerJson },
];

export async function detectProjectConfig(
  projectPath: string,
  environment: ProjectEnvironment,
  commandRunner?: CommandRunner,
): Promise<DetectedProjectConfig | null> {
  for (const { file, parser } of CONFIG_FILES) {
    const filePath = envJoin(environment, projectPath, file);
    const exists = await fileExists(filePath, environment, commandRunner, projectPath);
    if (exists) {
      try {
        const content = await readFile(filePath, environment, commandRunner, projectPath);
        return parser(content, file);
      } catch (err) {
        console.error(`[ProjectConfigDetector] Failed to parse ${file}:`, err);
        continue;
      }
    }
  }
  return null;
}

function parsePaneJson(content: string, source: string): DetectedProjectConfig | null {
  const raw = JSON.parse(content) as unknown;
  if (!raw || typeof raw !== 'object') return null;
  const json = raw as PaneJsonSchema;
  return {
    setup: json.scripts?.setup,
    run: json.scripts?.run,
    archive: json.scripts?.archive,
    runScriptMode: json.runScriptMode,
    source,
  };
}

function parseConductorJson(content: string, source: string): DetectedProjectConfig | null {
  return parsePaneJson(content, source);
}

function parseGitpodYml(content: string, source: string): DetectedProjectConfig | null {
  const raw = yaml.load(content) as unknown;
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as GitpodYmlSchema;
  const firstTask = doc.tasks?.[0];
  if (!firstTask) return { source };
  return {
    setup: firstTask.init,
    run: firstTask.command,
    source,
  };
}

function parseDevcontainerJson(content: string, source: string): DetectedProjectConfig | null {
  const stripped = stripJsonComments(content);
  const raw = JSON.parse(stripped) as unknown;
  if (!raw || typeof raw !== 'object') return null;
  const json = raw as DevcontainerJsonSchema;
  return {
    setup: normalizeCommand(json.postCreateCommand),
    run: normalizeCommand(json.postStartCommand),
    source,
  };
}

function normalizeCommand(cmd: string | string[] | undefined): string | undefined {
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) return cmd.join(' && ');
  return undefined;
}

function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Skip over strings — preserve their contents exactly
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          result += text[i] + (text[i + 1] || '');
          i += 2;
        } else {
          result += text[i];
          i++;
        }
      }
      if (i < text.length) {
        result += '"';
        i++;
      }
    }
    // Single-line comment
    else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    }
    // Block comment
    else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip closing */
    }
    // Regular character
    else {
      result += text[i];
      i++;
    }
  }
  return result;
}
