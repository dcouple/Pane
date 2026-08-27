import { execFile } from 'child_process';
import fs from 'fs/promises';
import https from 'https';
import path from 'path';
import { promisify } from 'util';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { getAppDirectory } from '../utils/appDirectory';
import type { Logger } from '../utils/logger';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

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
  'parsa/.codex/skills/gh-address-comments',
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
  'parsa/.claude/skills/gh-address-comments',
  'parsa/.claude/skills/review',
  'parsa/.claude/skills/teach-back',
  'parsa/.claude/skills/investigate',
  'parsa/.claude/skills/commit',
] as const;

const REQUIRED_FALLBACK_RAW_FILES = [
  ...TOP_LEVEL_FILES,
  ...IMPORTANT_SKILL_PATHS.map(skillPath => `${skillPath}/SKILL.md`),
  'parsa/.codex/skills/gh-address-comments/agents/openai.yaml',
  'parsa/.codex/skills/pr-test-automation/agents/openai.yaml',
  'parsa/.claude/skills/gh-address-comments/agents/openai.yaml',
  'parsa/.claude/skills/pr-test-automation/agents/openai.yaml',
  'parsa/.claude/skills/review/CRITERIA.md',
] as const;

const OPTIONAL_FALLBACK_RAW_FILES = [
  'parsa/.codex/skills/plan/plan_base.md',
  'parsa/.codex/skills/teach-back/agents/openai.yaml',
  'parsa/.codex/skills/pane-work-recap/SKILL.md',
  'parsa/.codex/skills/pane-work-recap/agents/openai.yaml',
  'parsa/.codex/skills/pane-work-prioritizer/SKILL.md',
  'parsa/.codex/skills/pane-work-prioritizer/agents/openai.yaml',
  'parsa/.claude/skills/create-plan/plan_base.md',
  'parsa/.claude/skills/pane-work-recap/SKILL.md',
  'parsa/.claude/skills/pane-work-prioritizer/SKILL.md',
] as const;

const FALLBACK_RAW_FILES = [
  ...REQUIRED_FALLBACK_RAW_FILES,
  ...OPTIONAL_FALLBACK_RAW_FILES,
] as const;

const REQUIRED_FALLBACK_RAW_FILE_SET = new Set<string>(REQUIRED_FALLBACK_RAW_FILES);

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
  readonly cursorPaneOrchestratorRulePath: string;
  readonly paneWatchScriptPath: string;
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
    this.cursorPaneOrchestratorRulePath = path.join(getAppDirectory(), '.cursor', 'rules', 'pane-orchestrator.mdc');
    this.paneWatchScriptPath = path.join(getAppDirectory(), 'tools', 'watch.py');
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
      this.logWarn(
        'Git skill sync unavailable; falling back to raw file download',
        error instanceof Error ? error : new Error(String(error)),
      );
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
    const requiredDownloadFailures: string[] = [];

    for (const relativePath of FALLBACK_RAW_FILES) {
      try {
        const bytes = await downloadBuffer(`${RAW_BASE_URL}/${encodeURIPath(relativePath)}`);
        const target = path.join(this.cacheRoot, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${relativePath}: ${message}`);
        if (REQUIRED_FALLBACK_RAW_FILE_SET.has(relativePath)) {
          requiredDownloadFailures.push(`${relativePath}: ${message}`);
        }
        this.logWarn(
          `Failed to download skill cache file ${relativePath}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    const missingRequiredFiles: string[] = [];
    for (const relativePath of REQUIRED_FALLBACK_RAW_FILES) {
      if (!(await exists(path.join(this.cacheRoot, relativePath)))) {
        missingRequiredFiles.push(relativePath);
      }
    }

    if (requiredDownloadFailures.length > 0 || missingRequiredFiles.length > 0) {
      const failureSummary = failures.length > 0
        ? ` Failed downloads: ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? '; ...' : ''}`
        : '';
      const failedRequiredSummary = requiredDownloadFailures.length > 0
        ? ` Required download failures: ${requiredDownloadFailures.slice(0, 5).join('; ')}${requiredDownloadFailures.length > 5 ? '; ...' : ''}`
        : '';
      const missingRequiredSummary = missingRequiredFiles.length > 0
        ? ` Missing required files: ${missingRequiredFiles.join(', ')}.`
        : '';
      throw new Error(
        `Skill cache fallback failed for required files.${missingRequiredSummary}${failedRequiredSummary}${failureSummary}`,
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
    await this.writeTextFile(this.cursorPaneOrchestratorRulePath, this.toCursorRule(orchestratorSkill));
    await this.writeTextFile(this.paneWatchScriptPath, this.buildPaneWatchScript());
    await fs.chmod(this.paneWatchScriptPath, 0o755);
  }

  /** Cursor reads .cursor/rules/*.mdc, not SKILL.md files — swap the frontmatter. */
  private toCursorRule(skill: string): string {
    const body = skill.startsWith('---\n')
      ? skill.split('---\n').slice(2).join('---\n').trim()
      : skill.trim();
    return `---\ndescription: Pane Chat orchestrator contract\nalwaysApply: true\n---\n\n${body}\n`;
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

## Contract Precedence

Use one unambiguous hierarchy:

1. The generated runtime context is authoritative for this exact Pane install,
   data directory, shell/runtime, and RunPane command routing.
2. The generated Pane Chat orchestrator skill is authoritative for Pane-specific
   role boundaries, focus preservation, pane/panel/worktree mechanics, cache
   paths, and delegation through RunPane.
3. The active agent's cached RunPane orchestrator skill is authoritative for the
   software-work lifecycle, delivery lanes, persisted intent and holds with
   live-state re-derivation, stage transitions,
   review-feedback interrupts, current-head evidence invalidation, and
   \`ready_to_merge\` predicate.
4. Agent-specific downstream skills are authoritative for how each lifecycle
   stage is performed.

The cached files may be refreshed by Pane in the background; do not fetch GitHub
just to initialize yourself.

For read-only work questions, use \`pane-work-recap\` when the user asks what
they worked on and \`pane-work-prioritizer\` when they ask what to work on next.
Ground both answers in RunPane, git, GitHub, and agent-log evidence before
starting new implementation panes.

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
- Stop before merge, deploy, release creation, publishing, version changes,
  production or destructive mutation, deleting user data, scope expansion, or
  other irreversible actions unless the user explicitly authorizes that exact
  step.

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
    const paneWatchScript = this.paneWatchScriptPath;

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
6. Reconstitute the in-flight work picture with this bounded live-state sweep
   before acting or answering a status question:
   1. Enumerate panes through RunPane. Use panel activity status, running panels,
      and linked artifacts to determine the active working set. Include
      unpinned panes; pinning is a UI favorite signal, not an activity signal.
   2. If activity is ambiguous, inspect all non-archived panes before narrowing
      to the active working set. Go wider than non-archived panes only when the
      user asks.
   3. Resolve what each active pane owns from the artifacts its panels report,
      the branch, and the worktree. Do not infer ownership from the pane name;
      names can drift from the work actually being handled.
   4. Query the VCS host for live state of the resolved artifacts: review state,
      mergeability, and check status.
   5. Discover connected sources instead of assuming them. Enumerate the
      integrations and tools actually available in this session, then crawl only
      the sources that carry work state for items assigned to the user or linked
      to the artifacts found above.
   6. Treat stored notes as leads to verify, not authority. Prefer fresh fields
      from RunPane, the VCS host, and discovered work-state sources over memory
      or cached summaries.
   7. Keep the sweep cheap: parallelize independent queries, inspect active panes
      plus directly linked records, cap fallback enumeration at non-archived
      panes, and avoid fetching full bodies when list, status, review,
      mergeability, or check fields answer the question.
   8. Report in decision-shaped terms: what moved since the user last looked,
      what is waiting on a human, and what is blocked and on what.

Do not claim initialization is complete until you have loaded these workflow
references, completed the bounded live-state sweep, and can name the intended
lifecycle for the user's task.

Arm \`python3 ${paneWatchScript}\` with the Monitor tool at session start; it
streams READY/BUSY/NEW/GONE from the daemon journal. Do not poll panes by hand
or screen-scrape terminal text to decide whether an agent is working. The
daemon's agent-status journal is the authoritative activity signal;
\`pane.status\` is not — it reports "stopped" for actively working agents.

For read-only work questions, use \`pane-work-recap\` when the user asks what
they worked on and \`pane-work-prioritizer\` when they ask what to work on next.
Do not start implementation panes for those answers unless the user asks you to.

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

Context is the scarce resource, and yours is the only one holding every pane at
once. Judge claims rather than re-deriving them: check that cited evidence
exists, that the claim follows from it, and that no gate was skipped. Cross-pane
work is the exception only you can do, since only you see two panes holding
contradictory instructions, or a pane whose name disagrees with what it owns.

Two questions catch most of what goes wrong, and both are cheap enough to ask by
default:

- Is this the root cause or a symptom? Agents routinely fix the symptom they
  were shown, and asking is usually enough for them to catch it themselves. Do
  not just hold this question: when a delegated discussion or investigation
  converges, send it to that agent verbatim — "is this addressing the root
  cause or a symptom? dig deep" — before accepting the design or recommending
  a lane. A premise-changing answer reopens the discussion.
- How do comparable products or open-source projects solve this? Check prior art
  hardest when a discussion concludes something is hard or impossible, because
  that conclusion is often wrong and cheap to falsify.

Deliverables addressed to a person get a third standing move. When a pane
completes something a human will read — a pull request body, a brief, a docs
page, a report — have it run the cached \`fresh-eyes\` skill before handoff: a
zero-context recipient review, repeated by a fresh-context agent until a pass
changes nothing. The producing agent cannot review its own work with fresh
eyes, which is also why the repeat is delegated, never skipped.

## Bring The Human In Before The Work

A missing fact costs one question beforehand and a rework cycle afterwards. The
facts most likely to be missing are the ones no sweep reaches: what a vendor
said, what a customer is owed, what a neighbouring system already solved.

Keep investigation and discussion with the user in the conversation: delegate
repository-backed legwork to panes, bring the findings back, and synthesize
here. The conversation is what stays; the digging is what delegates.

Before dispatching, do both:

- Ask about the gaps you can see. If the design changes when a claim turns out
  false, and neither the repository nor the work tracker supports it, ask.
- Write down the assumptions you are making. A user corrects the model they can
  see, so a stated assumption draws the correction an open question misses.

Where the work item already specifies the change, this collapses to a
confirmation. The design question must be settled and recorded; a full
discussion is optional.

Watching a run to catch assumptions costs context for tens of minutes and buys
little. Require every completed run to report what it assumed, and put that list
in front of the user with the result. An assumption the design hinges on is not
a report item: the run surfaces it as a blocker and waits.

After discussion, recommend a lane and say what it buys in verification terms.
The lane is the user's decision. Escalate a blocker, an open design fork, or an
ambiguity that would otherwise be settled by assumption; route everything else
without asking.

## Contract Precedence

Use one unambiguous hierarchy:

1. The generated runtime context is authoritative for this exact Pane install,
   data directory, shell/runtime, and RunPane command routing.
2. This generated Pane Chat orchestrator skill is authoritative for Pane-specific
   role boundaries, focus preservation, pane/panel/worktree mechanics, cache
   paths, and delegation through RunPane.
3. The active agent's cached RunPane orchestrator skill is authoritative for the
   software-work lifecycle, delivery lanes, persisted intent and holds with
   live-state re-derivation, stage transitions,
   review-feedback interrupts, current-head evidence invalidation, and
   \`ready_to_merge\` predicate.
4. Agent-specific downstream skills are authoritative for how each lifecycle
   stage is performed.

## Workflow Discipline

The active agent's cached \`runpane-orchestrator\` owns the lifecycle contract.
Do not maintain a second Pane-generated copy of that lifecycle. When delegating,
name the intended lifecycle stage and the relevant source artifact or brief.

Pane Chat owns discussion and clarification with the user when intent is
ambiguous, broad, creative, or multi-agent. It may distill that conversation
into concise briefs, constraints, success criteria, repo/worktree targets, and
autonomy boundaries before delegating the next lifecycle stage through RunPane.

Treat review feedback as an interrupt owned by the upstream lifecycle. When it
routes to \`gh-address-comments\`, use the implementation authority for source
fixes, separate source-edit grants from external-write grants, and rerun stale
current-head evidence after any head-changing fix.

Delegate discussion to another agent only when the user explicitly asks for a
separate perspective or when Pane Chat needs parallel research before forming
the brief. In that case, Pane Chat still synthesizes the discussion result before
advancing the upstream lifecycle.

## Pane Workflow Model

- Add a repository once, then use Pane to manage work against it. If no suitable
  repo exists, create a minimal local git repository and register it with Pane,
  then delegate project implementation through RunPane.
- The initial repository Pane is not a feature worktree; it represents the main
  repository checkout and should stay aligned with main.
- Creating a new Pane from a saved repository should normally create an
  isolated git worktree and branch for one feature, PR, or experiment.
  Multiple Panes can safely touch the same code areas because they are isolated
  by worktree and branch.
- Use extra terminal tabs/panels inside a Pane for clean-context review,
  discussion, test automation, or follow-up agents. For PR-ready work, prefer
  fresh Codex and Claude review panels.
- After a PR is merged, the user can archive the Pane, which safely archives the
  associated worktree.
- Pane may copy quality-of-life files such as env vars, modules, and other
  configured directories into new worktrees. Use RunPane and Pane state to
  inspect the actual setup instead of assuming.

## Orchestration Loop

For Pane work:

1. Use \`runpane panes list --json\` and \`runpane panels list --pane <pane-id>
   --json\` to stay synchronized.
2. Create panes or panels for the actual work with RunPane.
3. Send the task to the delegated agent.
4. Verify progress and completion with \`runpane panels wait\`,
   \`runpane panels screen\`, or \`runpane panels output\`.
5. Report observed Pane state and results back to the user.

RunPane command results describe what a command attempted, not the resulting
state. A success can leave nothing done; a failure can leave something done; a
safety check can be checking the wrong thing. Before treating any state as
changed or unchanged, verify the state itself:

- Reconcile against \`runpane panes list --json\` before retrying a create that
  reported failure — the pane and worktree may already exist.
- Confirm an agent turn actually started with \`runpane panels screen\` rather
  than trusting a submit result alone.
- Before archiving, establish what a pane produced. Investigation, research,
  review, and discussion panes deliver their result as terminal scrollback, not
  files — a clean worktree does not mean empty, and archiving destroys
  scrollback permanently.

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

Stop before merge, deploy, release creation, publishing, version changes,
production or destructive mutation, deleting user data, scope expansion, or
other irreversible actions unless the user explicitly authorizes that exact
step.
`;
  }

  private buildPaneWatchScript(): string {
    return `#!/usr/bin/env python3
"""Watch Pane journal events, pull requests, and deliverable files.

    python3 watch.py [--panes FILTER] [--prs owner/repo ...] [--files PATH ...]
                     [--interval SECONDS] [--state DIR] [--once]

Pane transitions come from the daemon-held runpane journal. The daemon owns the
silent baseline, transition detection, settle timing, and held-composer check.
PR and file checks remain periodic because they are external to Pane. Every
external call uses an argv list with shell=False.
"""

import argparse
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

def run_json(argv, timeout=45):
    """Run a command, parse stdout as JSON. Returns None on any failure.

    Never raises: a monitor must survive transient CLI/network errors rather
    than dying and leaving the caller with silence that looks like calm.
    """
    try:
        p = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
    except Exception:
        return None
    if not p.stdout:
        return None
    try:
        return json.loads(p.stdout)
    except Exception:
        return None


def run_text(argv, timeout=45):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, shell=False)
        return p.stdout or ""
    except Exception:
        return ""


def resolve_runpane():
    executable = shutil.which("runpane")
    if executable:
        return [executable]

    node = shutil.which("node")
    if node:
        for root in (Path.cwd(), *Path.cwd().parents):
            local_cli = root / "packages" / "runpane" / "dist" / "cli.js"
            if local_cli.is_file():
                return [node, str(local_cli)]

        npx_cache = Path.home() / (
            "AppData/Local/npm-cache/_npx" if os.name == "nt" else ".npm/_npx"
        )
        try:
            candidates = sorted(
                npx_cache.glob("*/node_modules/runpane/dist/cli.js"),
                key=lambda candidate: candidate.stat().st_mtime,
                reverse=True,
            )
            if candidates:
                return [node, str(candidates[0])]
        except Exception:
            pass

    npx = shutil.which("npx") or ("npx.cmd" if os.name == "nt" else "npx")
    return [npx, "--yes", "runpane@latest"]


def resolve_gh():
    return shutil.which("gh") or ("gh.exe" if os.name == "nt" else "gh")


def load_state(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return json.loads(path.read_text()) if path.exists() else {}
    except Exception:
        return {}


def state_changed(state, key, value):
    previous = state.get(key)
    if previous == value:
        return False, previous
    state[key] = value
    return True, previous


def save_state(path, state):
    try:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state))
        temporary.replace(path)
    except Exception:
        pass


def emit(line):
    print(line, flush=True)


def check_files(paths, state, first):
    for raw in paths:
        p = Path(raw).expanduser()
        if not p.is_file():
            continue
        changed, _ = state_changed(state, f"file:{p}", True)
        if not changed or first:
            continue
        try:
            n = sum(1 for _ in p.open(errors="ignore"))
        except Exception:
            n = 0
        emit(f"FILE   {p.name} ({n} lines)")


LABEL = {
    "agent.ready": "READY",
    "agent.busy": "BUSY",
    "agent.blocked": "BLOCKED",
    "agent.unknown": "UNKNOWN",
    "pane.created": "NEW",
    "pane.gone": "GONE",
    "panel.exited": "EXIT",
}


def emit_pane_entry(entry):
    if entry.get("baseline"):
        if entry.get("changedWhileAway"):
            name = entry.get("paneName") or entry.get("paneId") or "unknown"
            emit(f"READY? {name} (changed while away)")
        return
    kind = entry.get("kind")
    label = LABEL.get(kind)
    if not label:
        return
    name = entry.get("paneName") or entry.get("paneId") or "unknown"
    emit(f"{label:<6} {name}")
    held_input = entry.get("heldInput")
    if held_input:
        emit(f"STUCK  {name} :: {held_input[:70]}")


def watch_panes(name_filter, once):
    command = resolve_runpane() + [
        "watch", "--as", "watch.py", "--json", "--agents-only",
        "--include-held-input", "--timeout-ms", "0" if once else "60000",
    ]
    if name_filter:
        command.extend(["--name-contains", name_filter])
    if not once:
        command.append("--follow")

    while True:
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                shell=False,
            )
            if process.stdout:
                for line in process.stdout:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("kind") == "_reset":
                        emit(f"RESET  {entry.get('reason', 'unknown')}")
                        continue
                    emit_pane_entry(entry)
            return_code = process.wait()
            if not once:
                emit(f"WATCH EXIT rc={return_code} — reconnecting")
        except Exception as error:
            emit(f"WATCH ERROR: {type(error).__name__}: {error}")
        if once:
            return
        time.sleep(1)


def check_prs(gh, repos, state, first):
    for repo in repos:
        d = run_json([
            gh, "pr", "list", "--repo", repo, "--limit", "40",
            "--json", "number,isDraft,mergeable,title",
        ])
        if d is None:
            continue
        bkey = f"_baseline:{repo}"
        if first or bkey not in state:
            # Rule 1: everything already open is pre-existing, never reported.
            state[bkey] = [p["number"] for p in d]
            continue
        baseline = set(state.get(bkey, []))
        for p in d:
            num = p["number"]
            if num in baseline:
                continue
            out = run_text([gh, "pr", "checks", str(num), "--repo", repo])
            buckets = [ln.split("\\t")[1] for ln in out.splitlines() if "\\t" in ln]
            failing = any("fail" in b for b in buckets)
            pending = any("pending" in b for b in buckets)
            if not p["isDraft"] and p.get("mergeable") == "MERGEABLE" \\
                    and not failing and not pending:
                st = "ready"
            elif failing:
                st = "failing"
            else:
                st = "waiting"
            changed, _ = state_changed(state, f"pr:{repo}:{num}", st)
            if not changed:
                continue
            title = p.get("title", "")[:56]
            if st == "ready":
                emit(f"PR READY FOR REVIEW: {repo}#{num} — {title}")
            elif st == "failing":
                emit(f"PR CHECKS FAILING:   {repo}#{num} — {title}")


def main():
    ap = argparse.ArgumentParser(description="Generalized Pane workspace monitor.")
    ap.add_argument("--panes", default="", help="substring filter on pane name; empty = all")
    ap.add_argument("--prs", nargs="*", default=[], help="repos to watch, e.g. owner/name")
    ap.add_argument("--files", nargs="*", default=[], help="deliverable paths to watch for")
    ap.add_argument("--interval", type=int, default=60)
    ap.add_argument("--state", default=str(Path.home() / ".pane" / "tools" / "watch-state.json"))
    ap.add_argument("--once", action="store_true", help="single pass (seeds baseline), for testing")
    ap.add_argument("--no-panes", action="store_true", help="skip pane watching entirely")
    args = ap.parse_args()

    state_path = Path(args.state)
    state = load_state(state_path)
    first = "_seeded" not in state

    if not args.no_panes:
        if args.once:
            watch_panes(args.panes, True)
        else:
            threading.Thread(target=watch_panes, args=(args.panes, False), daemon=True).start()

    while True:
        try:
            check_files(args.files, state, first)
            if args.prs:
                check_prs(resolve_gh(), args.prs, state, first)
        except Exception as e:
            # Never die on a transient error — silence would read as "all calm".
            emit(f"WATCH ERROR: {type(e).__name__}: {e}")
        if first:
            state["_seeded"] = True
            first = False
        save_state(state_path, state)
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
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
      return decodeBoundary(JSON.parse(raw), boundary.object({
        lastAttemptAt: boundary.optional(boundary.string),
        lastSuccessAt: boundary.optional(boundary.string),
        sourceCommit: boundary.optional(boundary.string),
        lastError: boundary.optional(boundary.string),
      }));
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

  private logWarn(message: string, error?: Error): void {
    this.logger?.warn(`[SkillCache] ${message}`, error);
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
