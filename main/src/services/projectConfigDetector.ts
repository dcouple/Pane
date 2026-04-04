/**
 * Project Config File Detector
 *
 * Detects workspace configuration files at a project/worktree root and extracts
 * lifecycle scripts (setup, run, archive). Pane is tool-agnostic — it reads config
 * files from multiple workspace managers, not just its own format.
 *
 * Detection priority (first file with at least one script wins):
 *   1. pane.json         — Pane's native format (matches conductor.json schema)
 *   2. conductor.json    — Conductor.build workspace config
 *   3. .gitpod.yml       — Gitpod workspace config (first task's init/command)
 *   4. .devcontainer/devcontainer.json — Dev Containers (postCreateCommand/postStartCommand)
 *
 * The returned {@link DetectedProjectConfig} maps to Pane's project settings:
 *   - setup  → build_script  (runs on worktree creation)
 *   - run    → run_script    (runs on Play button click)
 *   - archive → archive_script (runs before worktree deletion)
 *
 * Override model (Conductor pattern): DB values in Project Settings always win.
 * Config files provide team-shared defaults that apply when no DB value is set.
 * Config files are read from the session's worktree path (not project root) so
 * branch-local changes are respected.
 *
 * @see {@link detectProjectConfig} — main entry point
 * @see resolve-run-script IPC in project.ts — uses this for Play button resolution
 * @see taskQueue.ts — uses this for build_script fallback on session creation
 * @see session.ts cleanup — uses this for archive_script fallback on session deletion
 */
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

/**
 * Detects and parses the highest-priority config file at the given path.
 *
 * Checks pane.json → conductor.json → .gitpod.yml → devcontainer.json in order.
 * Returns the first config that defines at least one script (setup/run/archive).
 * If a file exists but has no scripts, falls through to the next file.
 *
 * @param projectPath - Path to check for config files (typically session worktree path)
 * @param environment - Platform environment for correct path handling
 * @param commandRunner - Required for non-Windows environments (WSL/Linux/macOS)
 * @returns Parsed config with scripts and source filename, or null if nothing found
 */
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
        const result = parser(content, file);
        // Only return if the config has at least one script defined — otherwise
        // fall through to check lower-priority config files
        if (result && (result.setup || result.run || result.archive)) {
          return result;
        }
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
