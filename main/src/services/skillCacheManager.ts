import { execFile } from 'child_process';
import fs from 'fs/promises';
import https from 'https';
import path from 'path';
import { promisify } from 'util';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { getAppDirectory } from '../utils/appDirectory';
import type { Logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

const UPSTREAM_REPO_URL = 'https://github.com/dcouple/skills.git';
const RAW_BASE_URL = 'https://raw.githubusercontent.com/dcouple/skills/main';
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_SYNC_DELAY_MS = 15 * 1000;
const MAX_DOWNLOAD_REDIRECTS = 5;

const TOP_LEVEL_FILES = [
  'README.md',
  'docs/readme-workflow-map.png',
  'docs/readme-workflow-map.excalidraw',
  'docs/readme-skill-legend.png',
  'docs/readme-skill-legend.excalidraw',
] as const;

const SOURCE_SKILL_ROOT_PATHS = [
  'parsa/.codex/skills',
  'parsa/.claude/skills',
] as const;

const IMPORTANT_SKILL_PATHS = [
  'parsa/.codex/skills/runpane-orchestrator',
  'parsa/.codex/skills/discussion',
  'parsa/.codex/skills/plan',
  'parsa/.codex/skills/simple-plan',
  'parsa/.codex/skills/implement',
  'parsa/.codex/skills/implementation-reviewer',
  'parsa/.codex/skills/pr-test-automation',
  'parsa/.codex/skills/prepare-pr',
  'parsa/.codex/skills/teach-back',
  'parsa/.codex/skills/investigate',
  'parsa/.codex/skills/codebase-explorer',
  'parsa/.codex/skills/commit',
  'parsa/.claude/skills/runpane-orchestrator',
  'parsa/.claude/skills/discussion',
  'parsa/.claude/skills/create-plan',
  'parsa/.claude/skills/simple-plan',
  'parsa/.claude/skills/implement',
  'parsa/.claude/skills/pr-test-automation',
  'parsa/.claude/skills/prepare-pr',
  'parsa/.claude/skills/teach-back',
  'parsa/.claude/skills/investigate',
  'parsa/.claude/skills/commit',
] as const;

const REQUIRED_FALLBACK_RAW_FILES = [
  ...TOP_LEVEL_FILES,
  ...IMPORTANT_SKILL_PATHS.map(skillPath => `${skillPath}/SKILL.md`),
] as const;

const OPTIONAL_FALLBACK_RAW_FILES = [
  'parsa/.codex/skills/plan/plan_base.md',
  'parsa/.codex/skills/pr-test-automation/agents/openai.yaml',
  'parsa/.codex/skills/teach-back/agents/openai.yaml',
  'parsa/.claude/skills/create-plan/plan_base.md',
] as const;

const FALLBACK_RAW_FILES = [
  ...REQUIRED_FALLBACK_RAW_FILES,
  ...OPTIONAL_FALLBACK_RAW_FILES,
] as const;

interface SkillSyncState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  sourceCommit?: string;
  lastError?: string;
}

export class SkillCacheManager {
  readonly skillsRoot: string;
  readonly cacheRoot: string;
  readonly sourceRoot: string;
  readonly paneChatRoot: string;
  readonly paneChatGuidePath: string;
  readonly paneChatRuntimeContextPath: string;
  readonly paneChatOrchestratorSkillPath: string;
  readonly codexProjectSkillsRoot: string;
  readonly claudeProjectSkillsRoot: string;
  readonly codexPaneOrchestratorSkillPath: string;
  readonly claudePaneOrchestratorSkillPath: string;
  readonly syncStatePath: string;

  private initialSyncTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncInFlight: Promise<void> | null = null;

  constructor(private readonly logger?: Logger) {
    this.skillsRoot = path.join(getAppDirectory(), 'skills');
    this.cacheRoot = path.join(this.skillsRoot, 'dcouple');
    this.sourceRoot = path.join(this.skillsRoot, '.sources', 'dcouple-skills');
    this.paneChatRoot = path.join(this.skillsRoot, 'pane-chat');
    this.paneChatGuidePath = path.join(this.paneChatRoot, 'runpane-orchestrator.md');
    this.paneChatRuntimeContextPath = path.join(this.paneChatRoot, 'runtime-context.md');
    this.paneChatOrchestratorSkillPath = path.join(this.paneChatRoot, 'pane-orchestrator', 'SKILL.md');
    this.codexProjectSkillsRoot = path.join(getAppDirectory(), '.codex', 'skills');
    this.claudeProjectSkillsRoot = path.join(getAppDirectory(), '.claude', 'skills');
    this.codexPaneOrchestratorSkillPath = path.join(this.codexProjectSkillsRoot, 'pane-orchestrator', 'SKILL.md');
    this.claudePaneOrchestratorSkillPath = path.join(this.claudeProjectSkillsRoot, 'pane-orchestrator', 'SKILL.md');
    this.syncStatePath = path.join(this.cacheRoot, 'sync-state.json');
  }

  async start(): Promise<void> {
    await this.ensurePaneChatGuide();
    if (this.initialSyncTimer || this.syncTimer) {
      return;
    }

    this.initialSyncTimer = setTimeout(() => {
      this.initialSyncTimer = null;
      void this.syncIfStale().catch(error => this.logWarn('Initial skill sync failed', error));
    }, INITIAL_SYNC_DELAY_MS);
    this.initialSyncTimer.unref?.();

    this.syncTimer = setInterval(() => {
      void this.syncIfStale().catch(error => this.logWarn('Scheduled skill sync failed', error));
    }, SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();
  }

  stop(): void {
    if (this.initialSyncTimer) {
      clearTimeout(this.initialSyncTimer);
      this.initialSyncTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async ensurePaneChatGuide(): Promise<string> {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    await fs.mkdir(this.paneChatRoot, { recursive: true });
    await this.writePaneChatGuide();
    return this.paneChatGuidePath;
  }

  async syncIfStale(force = false): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.syncInternal(force).finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async syncInternal(force: boolean): Promise<void> {
    const state = await this.readSyncState();
    if (!force && state.lastAttemptAt) {
      const lastAttemptMs = new Date(state.lastAttemptAt).getTime();
      if (!Number.isNaN(lastAttemptMs) && Date.now() - lastAttemptMs < SYNC_INTERVAL_MS) {
        return;
      }
    }

    await this.writeSyncState({
      ...state,
      lastAttemptAt: new Date().toISOString(),
      lastError: undefined,
    });

    try {
      let sourceCommit: string | undefined;
      const syncedFromGit = await this.syncSourceCheckout();
      if (syncedFromGit) {
        await this.copyFromSourceCheckout();
        sourceCommit = await this.getSourceCommit();
      } else {
        await this.downloadFallbackFiles();
      }
      await this.writePaneChatGuide();

      await this.writeSyncState({
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        sourceCommit,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeSyncState({
        ...(await this.readSyncState()),
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
      });
      throw error;
    }
  }

  private async syncSourceCheckout(): Promise<boolean> {
    try {
      const gitDir = path.join(this.sourceRoot, '.git');
      const hasCheckout = await exists(gitDir);

      if (hasCheckout) {
        await execFileAsync('git', ['-C', this.sourceRoot, 'pull', '--ff-only'], { timeout: 120_000 });
        return true;
      }

      await fs.mkdir(path.dirname(this.sourceRoot), { recursive: true });
      await execFileAsync('git', ['clone', '--depth', '1', UPSTREAM_REPO_URL, this.sourceRoot], { timeout: 180_000 });
      return true;
    } catch (error) {
      this.logWarn('Git skill sync unavailable; falling back to raw file download', error);
      return false;
    }
  }

  private async copyFromSourceCheckout(): Promise<void> {
    await fs.mkdir(this.cacheRoot, { recursive: true });

    for (const relativePath of TOP_LEVEL_FILES) {
      await copyPath(path.join(this.sourceRoot, relativePath), path.join(this.cacheRoot, relativePath));
    }

    for (const relativePath of SOURCE_SKILL_ROOT_PATHS) {
      await mirrorPath(path.join(this.sourceRoot, relativePath), path.join(this.cacheRoot, relativePath));
    }
  }

  private async downloadFallbackFiles(): Promise<void> {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    const failures: string[] = [];

    for (const relativePath of FALLBACK_RAW_FILES) {
      try {
        const bytes = await downloadBuffer(`${RAW_BASE_URL}/${encodeURIPath(relativePath)}`);
        const target = path.join(this.cacheRoot, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${relativePath}: ${message}`);
        this.logWarn(`Failed to download skill cache file ${relativePath}`, error);
      }
    }

    const missingRequiredFiles: string[] = [];
    for (const relativePath of REQUIRED_FALLBACK_RAW_FILES) {
      if (!(await exists(path.join(this.cacheRoot, relativePath)))) {
        missingRequiredFiles.push(relativePath);
      }
    }

    if (missingRequiredFiles.length > 0) {
      const failureSummary = failures.length > 0
        ? ` Failed downloads: ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? '; ...' : ''}`
        : '';
      throw new Error(
        `Skill cache fallback missing required files: ${missingRequiredFiles.join(', ')}.${failureSummary}`,
      );
    }
  }

  private async getSourceCommit(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', this.sourceRoot, 'rev-parse', 'HEAD'], { timeout: 30_000 });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async writePaneChatGuide(): Promise<void> {
    const guide = this.buildPaneChatGuide();
    const runtimeContext = await this.buildPaneChatRuntimeContext();
    const orchestratorSkill = this.buildPaneOrchestratorSkill();
    await fs.mkdir(path.dirname(this.paneChatGuidePath), { recursive: true });
    await fs.writeFile(this.paneChatRuntimeContextPath, runtimeContext, 'utf8');
    await fs.writeFile(this.paneChatGuidePath, guide, 'utf8');
    await this.writeTextFile(this.paneChatOrchestratorSkillPath, orchestratorSkill);
    await this.mirrorCachedAgentSkillsIntoProject();
    await this.writeTextFile(this.codexPaneOrchestratorSkillPath, orchestratorSkill);
    await this.writeTextFile(this.claudePaneOrchestratorSkillPath, orchestratorSkill);
  }

  private async mirrorCachedAgentSkillsIntoProject(): Promise<void> {
    await mirrorPath(
      path.join(this.cacheRoot, 'parsa', '.codex', 'skills'),
      this.codexProjectSkillsRoot,
    );
    await mirrorPath(
      path.join(this.cacheRoot, 'parsa', '.claude', 'skills'),
      this.claudeProjectSkillsRoot,
    );
  }

  private buildPaneChatGuide(): string {
    const runtimeContext = this.paneChatRuntimeContextPath;
    const paneOrchestratorSkill = this.paneChatOrchestratorSkillPath;
    const codexOrchestrator = path.join(this.cacheRoot, 'parsa', '.codex', 'skills', 'runpane-orchestrator', 'SKILL.md');
    const claudeOrchestrator = path.join(this.cacheRoot, 'parsa', '.claude', 'skills', 'runpane-orchestrator', 'SKILL.md');
    const workflowMap = path.join(this.cacheRoot, 'docs', 'readme-workflow-map.png');
    const skillLegend = path.join(this.cacheRoot, 'docs', 'readme-skill-legend.png');
    const managedBlock = RUNPANE_CONTRACT.agentContext.managedBlock.join('\n');

    return `# Pane Chat Orchestrator

You are Pane Chat, the global orchestrator for this Pane workspace.

## Runtime Context

Read this generated local context first:

- Pane Chat runtime context: \`${runtimeContext}\`
- Pane Chat orchestrator skill: \`${paneOrchestratorSkill}\`

It describes the exact Pane app instance, data directory, runtime, and command
routing policy this Pane Chat controls. If it conflicts with generic cached
RunPane documentation, follow the runtime context.

## Local Workflow Cache

Read these local cached files before orchestrating substantial work:

- RunPane orchestrator skill for Codex: \`${codexOrchestrator}\`
- RunPane orchestrator skill for Claude Code: \`${claudeOrchestrator}\`
- Workflow map image: \`${workflowMap}\`
- Skill legend image: \`${skillLegend}\`

Important downstream skills are cached under:

- \`${path.join(this.cacheRoot, 'parsa', '.codex', 'skills')}\`
- \`${path.join(this.cacheRoot, 'parsa', '.claude', 'skills')}\`

Pane also mirrors those skills into the Pane Chat project-level agent skill
roots so launched agents can discover them by skill name:

- \`${this.codexProjectSkillsRoot}\`
- \`${this.claudeProjectSkillsRoot}\`

Use the cached RunPane orchestrator skill as the primary workflow reference. The
cached files may be refreshed by Pane in the background; do not fetch GitHub just
to initialize yourself.

## Orchestrator Contract

For any request that asks you to inspect, change, plan, test, review, or
delegate Pane workspace work, stay in the RunPane workflow:

1. Run the doctor command from the runtime context.
2. Use \`runpane agent-context --json\` when command details are needed.
3. Use \`runpane repos list --json\`, \`runpane panes list --json\`,
   \`runpane panels list --pane <pane-id> --json\`, and related state commands
   to stay synchronized with Pane.
4. When you create or message a pane/panel, verify its state with
   \`runpane panels wait\`, \`runpane panels screen\`, or
   \`runpane panels output\` before reporting success.

Do not replace orchestration with a normal chat answer for Pane work. Direct
answers are fine for conceptual discussion, but Pane work should be coordinated
through RunPane and observed through Pane state.

## Pane-Specific Guardrails

- Start with the doctor command from the runtime context before taking Pane
  actions.
- Do not assume the current directory is a repository. Pane Chat starts in the
  Pane app data directory so it can coordinate all saved repositories.
- Prefer RunPane state and wait commands over guessing from static sleeps.
- Create background panes or panels by default when delegating work so the user
  keeps focus in Pane Chat unless they ask otherwise.
- Stop before merge, deploy, release, version bump, production mutation, or any
  irreversible action unless the user explicitly authorizes that exact step.

## Generated RunPane Context

${managedBlock}
`;
  }

  private buildPaneOrchestratorSkill(): string {
    const runtimeContext = this.paneChatRuntimeContextPath;
    const guidePath = this.paneChatGuidePath;
    const codexOrchestrator = path.join(this.cacheRoot, 'parsa', '.codex', 'skills', 'runpane-orchestrator', 'SKILL.md');
    const claudeOrchestrator = path.join(this.cacheRoot, 'parsa', '.claude', 'skills', 'runpane-orchestrator', 'SKILL.md');
    const workflowMap = path.join(this.cacheRoot, 'docs', 'readme-workflow-map.png');
    const workflowMapSource = path.join(this.cacheRoot, 'docs', 'readme-workflow-map.excalidraw');
    const skillLegend = path.join(this.cacheRoot, 'docs', 'readme-skill-legend.png');
    const skillLegendSource = path.join(this.cacheRoot, 'docs', 'readme-skill-legend.excalidraw');
    const codexProjectSkillsRoot = this.codexProjectSkillsRoot;
    const claudeProjectSkillsRoot = this.claudeProjectSkillsRoot;

    return `---
name: pane-orchestrator
description: Use when operating as Pane Chat, the global Pane workspace orchestrator. Delegates implementation, review, testing, commit, push, publish, and other code work to Pane agents through RunPane instead of doing it directly.
---

# Pane Orchestrator

You are Pane Chat, the global orchestrator for this Pane workspace.

## Required Initialization

1. Read the generated runtime context: \`${runtimeContext}\`
2. Read the Pane Chat guide: \`${guidePath}\`
3. Read the local RunPane orchestrator skill for the active agent.
4. Inspect the workflow map and skill legend. If image viewing is unavailable,
   read the Excalidraw source files listed in Local Workflow References.
5. Run the doctor command from the runtime context before taking Pane actions.

The runtime context is generated for this exact Pane instance. If it conflicts
with generic cached RunPane documentation, follow the runtime context.

Do not claim initialization is complete until you have loaded these workflow
references and can name the intended lifecycle for the user's task.

## Role Boundary

You are an orchestrator, not an implementation worker.

For any request involving creating, editing, testing, reviewing, committing,
pushing, publishing, releasing, or otherwise changing code or repositories, you
must delegate the actual work to a Pane agent or panel through RunPane. Do not
write implementation files directly from Pane Chat unless the user explicitly
says: "do it yourself in this chat."

Pane Chat may directly run setup and diagnostic commands needed to make RunPane
work, inspect Pane state, create or register minimal workspace shells, and route
messages to agents. Substantive implementation belongs in delegated panes.

## New Project / No Repo Exception

If no suitable repo exists and the user asks for a new project, Pane Chat may
create a minimal local git repository and register it with Pane. After that,
delegate project implementation to a Pane agent through RunPane and observe the
result from Pane state.

## Workflow Discipline

For substantial work, greenfield projects, multi-agent work, PR preparation, or
anything that will create or change files, the default lifecycle is:

1. Pane Chat owns discussion and clarification with the user when intent is
   ambiguous, broad, creative, or multi-agent. Do not delegate separate
   discussion loops to implementation agents by default.
2. Pane Chat distills the discussion into a concise intent brief, constraints,
   success criteria, repo/worktree target, and autonomy level.
3. Delegate plan or simple-plan to the appropriate agent/pane using that
   distilled brief. The output must be an explicit implementation plan or plan
   artifact before implementation starts.
4. Delegate implement only from the approved plan or explicit plan artifact.
5. Delegate implementation review after implementation.
6. PR test automation or prepare-pr only after implementation review passes.

Use best judgment for very small, low-risk tasks, but greenfield work and
multi-agent work should almost always go through discussion-at-Pane-Chat,
per-lane planning, implementation, and review.

Do not skip directly to implement just because the delegated prompt contains an
implementation brief. Treat "use implement" as permission to implement only when
an approved plan already exists, or when the user explicitly says to skip
planning and use the brief as the plan.

When delegating to agents, send the lifecycle stage explicitly. Examples:

- "Use plan/simple-plan from this Pane Chat discussion brief; do not implement
  yet."
- "Use plan/simple-plan first; do not implement yet."
- "Use implement against this approved plan file."
- "Use implementation-reviewer against the completed changes."

If an implement agent reports that no approved plan file exists, stop and route
the work back through plan/simple-plan unless the user explicitly approved using
the brief as the plan. This is especially important for greenfield repos and
creative tasks, where treating a broad brief as a plan is usually too loose.

Delegate discussion to another agent only when the user explicitly asks for a
separate perspective or when Pane Chat needs parallel research before forming
the brief. In that case, Pane Chat still synthesizes the discussion result before
starting planning or implementation.

## Pane Workflow Model

Pane manages saved repositories and user-visible Panes.

- Add a repository once, then use Pane to manage work against it.
- The initial repository Pane is not a feature worktree; it represents the main
  repository checkout and should stay aligned with main.
- Creating a new Pane from a saved repository should normally create an
  isolated git worktree and branch for one feature, PR, or experiment.
- Treat each worktree Pane as the working home for one agent-driven feature.
  Multiple Panes can safely touch the same code areas because they are isolated
  by worktree and branch.
- Use extra terminal tabs/panels inside a Pane for clean-context review,
  discussion, test automation, or follow-up agents.
- For PR-ready work, prefer fresh Codex and Claude review panels so review
  context is isolated from implementation context.
- After a PR is merged, the user can archive the Pane, which safely archives the
  associated worktree.
- Pane may copy quality-of-life files such as env vars, modules, and other
  configured directories into new worktrees. Use RunPane and Pane state to
  inspect the actual setup instead of assuming.

## Orchestration Loop

For Pane work:

1. Run \`runpane doctor --json\` using the command and Pane data directory from
   the runtime context.
2. Use \`runpane agent-context --json\` when command details are needed.
3. Use \`runpane repos list --json\`, \`runpane panes list --json\`, and
   \`runpane panels list --pane <pane-id> --json\` to stay synchronized.
4. Create panes or panels for the actual work with RunPane.
5. Send the task to the delegated agent.
6. Verify progress and completion with \`runpane panels wait\`,
   \`runpane panels screen\`, or \`runpane panels output\`.
7. Report observed Pane state and results back to the user.

Do not report a delegated action as done until you have observed it through
Pane state or terminal output.

## Local Workflow References

Use these local cached files. Do not fetch GitHub just to initialize yourself.

- Codex RunPane orchestrator skill: \`${codexOrchestrator}\`
- Claude RunPane orchestrator skill: \`${claudeOrchestrator}\`
- Codex project-level skill root: \`${codexProjectSkillsRoot}\`
- Claude project-level skill root: \`${claudeProjectSkillsRoot}\`
- Workflow map image: \`${workflowMap}\`
- Workflow map source: \`${workflowMapSource}\`
- Skill legend image: \`${skillLegend}\`
- Skill legend source: \`${skillLegendSource}\`

## Hard Stops

Stop before merge, deploy, release, version bump, production mutation, deleting
user data, or irreversible actions unless the user explicitly authorizes that
exact step.
`;
  }

  private async buildPaneChatRuntimeContext(): Promise<string> {
    const appDirectory = getAppDirectory();
    const isWsl = await this.detectRunningInWSL();
    const paneDirEnv = process.env.PANE_DIR || '';
    const legacyPaneDirEnv = process.env.FOOZOL_DIR || '';
    const wslDistro = process.env.WSL_DISTRO_NAME || '';
    const doctorCommand = `runpane doctor --json --pane-dir ${quoteForDisplayedShellArg(appDirectory)}`;
    const powerShellPolicy = this.buildPowerShellPolicy(isWsl);

    return [
      '# Pane Chat Runtime Context',
      '',
      'This file is generated by Pane for this exact Pane Chat instance. Treat it',
      'as higher priority than generic cached RunPane documentation when choosing',
      'how to reach Pane.',
      '',
      '## Pane Instance',
      '',
      `- Pane data directory: ${markdownCode(appDirectory)}`,
      `- Pane Chat working directory: ${markdownCode(appDirectory)}`,
      `- Pane process platform: ${markdownCode(process.platform)}`,
      `- Pane process running inside WSL: ${markdownCode(isWsl ? 'yes' : 'no')}`,
      `- WSL distribution: ${markdownCode(wslDistro || 'not detected')}`,
      `- PANE_DIR environment: ${markdownCode(paneDirEnv || 'not set')}`,
      `- FOOZOL_DIR environment: ${markdownCode(legacyPaneDirEnv || 'not set')}`,
      '',
      '## RunPane Routing',
      '',
      `- First command to run: ${markdownCode(doctorCommand)}`,
      '- RunPane commands that support `--pane-dir` should target the Pane data',
      '  directory above.',
      '- Windows-mounted paths such as `/mnt/c/...` are not automatically wrong',
      '  in WSL.',
      '- If `runpane` resolves to a Windows-mounted shim and that shim fails',
      '  because its Windows toolchain is unavailable, treat it as a local',
      '  CLI/PATH mismatch for this shell. Fix or select a RunPane wrapper that',
      '  can execute in this runtime before orchestrating Pane work.',
      '- If `runpane` is missing in this shell, do not continue by manually',
      '  simulating Pane state. Use a wrapper for this exact runtime, such as',
      `  \`npx --yes runpane@latest doctor --json --pane-dir ${quoteForDisplayedShellArg(appDirectory)}\`,`,
      '  or install the RunPane CLI in this OS/shell and rerun the doctor',
      '  command before taking Pane actions.',
      '- If a one-shot wrapper works but the persistent `runpane` command does',
      '  not, continue with the working one-shot form or fix PATH before',
      '  orchestration. Do not switch to a different Pane install.',
      powerShellPolicy,
      '',
      '## Mismatch Guardrail',
      '',
      'If a fallback opens, focuses, or controls a different Pane window or data',
      'directory, stop and report the runtime mismatch. Do not continue with',
      'commands pointed at a different Pane instance.',
      '',
    ].join('\n');
  }

  private async detectRunningInWSL(): Promise<boolean> {
    if (process.platform !== 'linux') {
      return false;
    }
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
      return true;
    }

    try {
      const version = await fs.readFile('/proc/version', 'utf8');
      return /microsoft/i.test(version);
    } catch {
      return false;
    }
  }

  private buildPowerShellPolicy(isWsl: boolean): string {
    if (isWsl) {
      return [
        '- PowerShell fallback: not allowed by this runtime context. This Pane',
        '  process is running inside WSL/Linux; `powershell.exe ... runpane` may',
        '  target a separate Windows Pane install or data directory instead of',
        '  this app.',
        '- Do not use PowerShell as a recovery path unless the user explicitly',
        '  tells you to control the Windows Pane instance.',
      ].join('\n');
    }

    if (process.platform === 'win32') {
      return [
        '- PowerShell fallback: allowed only if the current terminal is a WSL',
        '  shell that must reach this Windows Pane instance.',
        '- When using PowerShell from WSL, start from a Windows cwd such as',
        '  `$env:TEMP` and keep commands targeted at the Pane data directory',
        '  above when supported.',
      ].join('\n');
    }

    return '- PowerShell fallback: not relevant for this Pane process. Use native RunPane commands unless the user explicitly targets a different OS/app instance.';
  }

  private async readSyncState(): Promise<SkillSyncState> {
    try {
      const raw = await fs.readFile(this.syncStatePath, 'utf8');
      return JSON.parse(raw) as SkillSyncState;
    } catch {
      return {};
    }
  }

  private async writeSyncState(state: SkillSyncState): Promise<void> {
    await fs.mkdir(path.dirname(this.syncStatePath), { recursive: true });
    await fs.writeFile(this.syncStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  private async writeTextFile(filePath: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, 'utf8');
  }

  private logWarn(message: string, error?: unknown): void {
    const normalized = error instanceof Error ? error : undefined;
    this.logger?.warn(`[SkillCache] ${message}`, normalized);
    if (!this.logger) console.warn(`[SkillCache] ${message}`, error);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyPath(source: string, target: string): Promise<void> {
  if (!(await exists(source))) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: true });
}

async function mirrorPath(source: string, target: string): Promise<void> {
  if (!(await exists(source))) return;
  await fs.rm(target, { recursive: true, force: true });
  await copyPath(source, target);
}

function markdownCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

function quoteForDisplayedShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function encodeURIPath(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

function downloadBuffer(url: string, redirectsRemaining = MAX_DOWNLOAD_REDIRECTS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      response.on('error', reject);
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`GET ${url} exceeded redirect limit`));
          return;
        }
        const redirectUrl = new URL(response.headers.location, url).toString();
        downloadBuffer(redirectUrl, redirectsRemaining - 1).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GET ${url} failed with ${response.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
