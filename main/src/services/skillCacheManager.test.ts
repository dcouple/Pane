import fs from 'fs/promises';
import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillCacheManager } from './skillCacheManager';

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function mockRequest(emitter: EventEmitter): ReturnType<typeof https.get> {
  // SAFETY: The download code only consumes EventEmitter request behavior in
  // these tests; no socket methods are reached.
  return emitter as ReturnType<typeof https.get>;
}

function mockResponse(emitter: EventEmitter): IncomingMessageLike {
  // SAFETY: Tests install statusCode, headers, and resume before delivery.
  return emitter as IncomingMessageLike;
}

function managerDownloads(manager: SkillCacheManager): Promise<void> {
  // SAFETY: This deliberate test seam mirrors the private fallback downloader.
  return (manager as { downloadFallbackFiles: () => Promise<void> }).downloadFallbackFiles();
}

function mockRawDownloads(failures = new Set<string>()) {
  return vi.spyOn(https, 'get').mockImplementation((url, callback) => {
    const request = mockRequest(new EventEmitter());
    const pathname = new URL(String(url)).pathname;
    const relativePath = decodeURIComponent(pathname.replace('/dcouple/skills/main/', ''));
    const response = mockResponse(new EventEmitter());

    response.headers = {};
    response.resume = vi.fn();

    if (failures.has(relativePath)) {
      response.statusCode = 500;
      process.nextTick(() => {
        callback(response);
        response.emit('end');
      });
      return request;
    }

    response.statusCode = 200;
    process.nextTick(() => {
      callback(response);
      response.emit('data', Buffer.from(`# ${relativePath}\n`));
      response.emit('end');
    });
    return request;
  });
}

interface IncomingMessageLike extends EventEmitter {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  resume: () => void;
}

const pythonProbe = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
  encoding: 'utf8',
});
const pythonExecutable = pythonProbe.status === 0
  ? pythonProbe.stdout.trim()
  : 'python3';

async function writeLocalRunpaneStub(root: string, source: string): Promise<string | undefined> {
  const cliPath = path.join(root, 'packages', 'runpane', 'dist', 'cli.js');
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(cliPath, source, 'utf8');
  if (process.platform !== 'win32') return undefined;

  const shimDirectory = path.join(root, 'shim-bin');
  const installedCliPath = path.join(shimDirectory, 'node_modules', 'runpane', 'dist', 'cli.js');
  await fs.mkdir(path.dirname(installedCliPath), { recursive: true });
  await fs.writeFile(installedCliPath, source, 'utf8');
  await fs.writeFile(path.join(shimDirectory, 'runpane.cmd'), '@echo off\r\nexit /b 99\r\n', 'utf8');
  return shimDirectory;
}

function localCliEnvironment(shimDirectory?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [shimDirectory, path.dirname(process.execPath)].filter(Boolean).join(path.delimiter),
  };
}

describe('SkillCacheManager Pane Chat guide', () => {
  const originalPaneDir = process.env.PANE_DIR;
  let tempDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-skill-cache-test-'));
    process.env.PANE_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalPaneDir === undefined) {
      delete process.env.PANE_DIR;
    } else {
      process.env.PANE_DIR = originalPaneDir;
    }

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('writes a Pane Chat guide that points at local cached workflow assets', async () => {
    const manager = new SkillCacheManager();

    await manager.ensurePaneChatGuide();

    const guide = await fs.readFile(manager.paneChatGuidePath, 'utf8');
    const normalizedGuide = normalizePathSeparators(guide);
    expect(guide).toContain('Pane Chat orchestrator skill');
    expect(guide).toContain('RunPane orchestrator skill for Codex');
    expect(normalizedGuide).toContain('/skills/dcouple/parsa/.codex/skills/runpane-orchestrator/SKILL.md');
    expect(normalizedGuide).toContain('/skills/dcouple/docs/readme-workflow-map.png');
    expect(guide).toContain('pane-work-recap');
    expect(guide).toContain('pane-work-prioritizer');
    expect(guide).toContain('when they ask what to work on next');
    expect(guide).toContain('Do not replace orchestration with a normal chat answer for Pane work.');
    expect(guide).toContain('verify its state with');
    expect(guide).toContain('Liveness is governed by the Liveness Contract');
    expect(guide).toContain('never write a watcher');
    expect(guide).toContain('## Contract Precedence');
    expect(guide).toContain("active agent's cached RunPane orchestrator skill is authoritative for the");
    expect(guide).toContain('review-feedback interrupts, current-head evidence invalidation, and');
    expect(guide).toContain('`ready_to_merge` predicate');
    expect(guide).toContain('Stop before merge, deploy, release creation, publishing, version changes');
  });

  it('writes runtime context with same-runtime CLI recovery guidance', async () => {
    const manager = new SkillCacheManager();

    await manager.ensurePaneChatGuide();

    const runtimeContext = await fs.readFile(manager.paneChatRuntimeContextPath, 'utf8');
    expect(runtimeContext).toContain('First command to run: `runpane doctor --json --pane-dir');
    expect(runtimeContext).toContain('If `runpane` is missing in this shell');
    expect(runtimeContext).toContain('npx --yes runpane@latest doctor --json --pane-dir');
    expect(runtimeContext).toContain('Do not switch to a different Pane install.');
  });

  it('writes a launcher for the one canonical daemon-backed watcher', async () => {
    const manager = new SkillCacheManager();

    await manager.ensurePaneChatGuide();

    const watcher = await fs.readFile(manager.paneWatchScriptPath, 'utf8');
    expect(watcher).toContain('def resolve_runpane');
    expect(watcher).toContain('root / "packages" / "runpane" / "dist" / "cli.js"');
    expect(watcher).toContain('command = resolve_runpane() + (');
    expect(watcher).toContain('["watch", "--follow"]');
    expect(watcher).toContain('stderr=subprocess.STDOUT');
    expect(watcher).toContain('encoding="utf-8"');
    expect(watcher).toContain('errors="replace"');
    expect(watcher).toContain('installed_cli = Path(executable).parent / "node_modules"');
    expect(watcher).toContain('WATCH ERROR child-exit');
    expect(watcher).not.toContain('DEVNULL');
    expect(watcher).not.toContain('json.loads');
    expect(watcher).not.toContain('HEARTBEAT');
    expect(watcher).not.toContain('IDLE_INTERVAL');
  });

  it.skipIf(pythonProbe.status !== 0)(
    'makes launcher child failures unmistakable',
    async () => {
      const manager = new SkillCacheManager();
      await manager.ensurePaneChatGuide();
      if (!tempDir) throw new Error('expected test temp directory');
      const shimDirectory = await writeLocalRunpaneStub(tempDir, [
        "process.stderr.write('daemon-stderr\\n');",
        'process.exit(3);',
      ].join('\n'));
      const result = spawnSync(pythonExecutable, [manager.paneWatchScriptPath, '--once'], {
        encoding: 'utf8',
        cwd: tempDir,
        env: localCliEnvironment(shimDirectory),
      });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain('daemon-stderr');
      expect(result.stdout).toContain('WATCH ERROR child-exit rc=3');
    },
  );

  it('writes an executable, daemon-dependent fallback watcher', async () => {
    const manager = new SkillCacheManager();
    await manager.ensurePaneChatGuide();
    const watcher = await fs.readFile(manager.paneIdleWatchScriptPath, 'utf8');
    const mode = (await fs.stat(manager.paneIdleWatchScriptPath)).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o755);
    }
    expect(watcher).toContain('WATCH OK fallback');
    expect(watcher).toContain('WATCH ERROR {type(error).__name__}: {clean(error)}');
    expect(watcher).toContain('def resolve_runpane');
    expect(watcher).toContain('WORKING = re.compile');
    expect(watcher).toContain('ERROR = re.compile');
    expect(watcher).toContain('PROMPT = re.compile');
    expect(watcher).toContain('TERMINAL = re.compile');
    expect(watcher).toContain('shell=False');
    expect(watcher).toContain('encoding="utf-8"');
    expect(watcher).toContain('errors="replace"');
    expect(watcher).toContain('installed_cli = Path(executable).parent / "node_modules"');
    expect(watcher).not.toContain('panels submit');
    const compiled = spawnSync(pythonExecutable, ['-m', 'py_compile', manager.paneWatchScriptPath, manager.paneIdleWatchScriptPath]);
    expect(compiled.status).toBe(0);
    if (!tempDir) throw new Error('expected test temp directory');
    const shimDirectory = await writeLocalRunpaneStub(tempDir, `
const args = process.argv.slice(2);
const panelIndex = args.indexOf('--panel');
const panel = panelIndex >= 0 ? args[panelIndex + 1] : '';
if (panel === 'bad') process.exit(3);
if (panel === 'array') {
  process.stdout.write('[]\\n');
  process.exit(0);
}
const payloads = {
  error: ${JSON.stringify({ ok: true, paneId: 'pane-real', text: 'API Error: broken', panelId: 'error', composer: { hasUndeliveredText: false } })},
  working: ${JSON.stringify({ ok: true, paneId: 'pane-real', text: 'esc to interrupt', panelId: 'working', composer: { hasUndeliveredText: false } })},
};
const payload = payloads[panel] ?? ${JSON.stringify({ ok: true, paneId: 'pane-real', text: '❯ esc to interrupt', panelId: 'panel-1' })};
process.stdout.write(JSON.stringify(payload) + '\\n');
`);
    const env = localCliEnvironment(shimDirectory);
    const options = { encoding: 'utf8' as const, cwd: tempDir, env };
    const success = spawnSync(pythonExecutable, [manager.paneIdleWatchScriptPath, '--once', 'panel-1:Demo'], options);
    expect(success.status).toBe(0);
    expect(success.stdout).toContain('IDLE Demo 3m pane pane-real panel panel-1');
    expect(success.stdout).not.toContain('pane Demo');
    const working = spawnSync(pythonExecutable, [
      manager.paneIdleWatchScriptPath,
      '--once',
      'working:Working',
    ], options);
    expect(working.status).toBe(0);
    expect(working.stdout).not.toContain('IDLE Working');
    const classifiedError = spawnSync(pythonExecutable, [
      manager.paneIdleWatchScriptPath,
      '--once',
      'error:Broken',
    ], options);
    expect(classifiedError.status).toBe(2);
    expect(classifiedError.stdout).toContain('WATCH ERROR fallback-panel Broken pane pane-real panel error');
    const failure = spawnSync(pythonExecutable, [
      manager.paneIdleWatchScriptPath,
      '--once',
      'panel-1:Demo',
      'bad:Broken',
    ], options);
    expect(failure.status).toBe(2);
    expect(failure.stdout).toContain('WATCH ERROR RuntimeError: screen-failed panel bad');
    const invalidJson = spawnSync(pythonExecutable, [
      manager.paneIdleWatchScriptPath,
      '--once',
      'array:Broken',
    ], options);
    expect(invalidJson.status).toBe(2);
    expect(invalidJson.stdout).toContain('WATCH ERROR RuntimeError: screen-invalid panel array');
    const malformedTarget = spawnSync(pythonExecutable, [
      manager.paneIdleWatchScriptPath,
      '--once',
      'missing-separator',
    ], options);
    expect(malformedTarget.status).toBe(2);
    expect(malformedTarget.stdout).toContain('WATCH ERROR ValueError: targets must use PANEL_ID:NAME');
    expect(malformedTarget.stderr).toBe('');
    const malformedInterval = spawnSync(pythonExecutable, [
      manager.paneIdleWatchScriptPath,
      '--once',
      'panel-1:Demo',
    ], { ...options, env: { ...env, IDLE_INTERVAL: 'not-a-number' } });
    expect(malformedInterval.status).toBe(2);
    expect(malformedInterval.stdout).toContain('WATCH ERROR ValueError: invalid literal for int()');
    expect(malformedInterval.stderr).toBe('');
  });

  it('writes project-scoped pane-orchestrator skills for Codex and Claude', async () => {
    const manager = new SkillCacheManager();

    await manager.ensurePaneChatGuide();

    const canonicalSkill = await fs.readFile(manager.paneChatOrchestratorSkillPath, 'utf8');
    const codexSkill = await fs.readFile(manager.codexPaneOrchestratorSkillPath, 'utf8');
    const claudeSkill = await fs.readFile(manager.claudePaneOrchestratorSkillPath, 'utf8');

    expect(normalizePathSeparators(manager.paneChatOrchestratorSkillPath)).toContain('/skills/pane-chat/pane-orchestrator/SKILL.md');
    expect(normalizePathSeparators(manager.codexPaneOrchestratorSkillPath)).toContain('/.codex/skills/pane-orchestrator/SKILL.md');
    expect(normalizePathSeparators(manager.claudePaneOrchestratorSkillPath)).toContain('/.claude/skills/pane-orchestrator/SKILL.md');
    expect(codexSkill).toBe(canonicalSkill);
    expect(claudeSkill).toBe(canonicalSkill);
    expect(canonicalSkill).toContain('name: pane-orchestrator');
    expect(canonicalSkill).toContain('You are an orchestrator, not an implementation worker.');
    expect(canonicalSkill).toContain('## Liveness Contract (non-negotiable)');
    expect(canonicalSkill).toContain('Never write, generate, or run an ad-hoc watcher');
    expect(canonicalSkill).toContain('On 2026-08-28 an inline watcher');
    expect(canonicalSkill).toContain('runpane watch --self-test');
    expect(canonicalSkill).toContain('runpane watch --follow');
    expect(canonicalSkill).toContain('READY <pane> pane P panel Q');
    expect(canonicalSkill).toContain('BLOCKED <pane> pane P panel Q');
    expect(canonicalSkill).toContain('IDLE <pane> 10m pane P panel Q');
    expect(canonicalSkill).toContain('STUCK <pane> … held-input-present');
    expect(canonicalSkill).toContain('HEARTBEAT gen N at T');
    expect(canonicalSkill).toContain('WATCH ERROR <code>: <msg>');
    expect(canonicalSkill).toContain('WATCH RECONNECTED gen N');
    expect(canonicalSkill).toContain('daemon is unreachable → no watcher fallback works');
    expect(canonicalSkill).toContain('must delegate the actual work to a Pane agent or panel through RunPane');
    expect(canonicalSkill).toContain('unless the user explicitly');
    expect(canonicalSkill).toContain('says: "do it yourself in this chat."');
    expect(canonicalSkill).toContain('Inspect the workflow map and skill legend');
    expect(canonicalSkill).toContain('Reconstitute the in-flight work picture with this bounded live-state sweep');
    expect(canonicalSkill).toContain('Use panel activity status, running panels');
    expect(canonicalSkill).toContain('unpinned panes');
    expect(canonicalSkill).toContain('pinning is a UI favorite signal');
    expect(canonicalSkill).toContain('inspect all non-archived panes before narrowing');
    expect(canonicalSkill).toContain('Do not infer ownership from the pane name');
    expect(canonicalSkill).toContain('Query the VCS host for live state');
    expect(canonicalSkill).toContain('Discover connected sources instead of assuming them');
    expect(canonicalSkill).toContain('Treat stored notes as leads to verify, not authority');
    expect(canonicalSkill).toContain('Keep the sweep cheap: parallelize independent queries');
    expect(canonicalSkill).toContain('cap fallback enumeration at non-archived');
    expect(canonicalSkill).toContain('avoid fetching');
    expect(canonicalSkill).toContain('Report in decision-shaped terms');
    expect(canonicalSkill).toContain('Do not claim initialization is complete');
    expect(canonicalSkill).toContain('completed the bounded live-state sweep');
    expect(canonicalSkill).toContain('## Contract Precedence');
    expect(canonicalSkill).toContain('The generated runtime context is authoritative');
    expect(canonicalSkill).toContain("active agent's cached RunPane orchestrator skill is authoritative");
    expect(canonicalSkill).toContain('persisted intent and holds');
    expect(canonicalSkill).toContain('review-feedback interrupts');
    expect(canonicalSkill).toContain('current-head evidence invalidation');
    expect(canonicalSkill).toContain('`ready_to_merge` predicate');
    expect(canonicalSkill).toContain('Pane Chat owns discussion and clarification with the user');
    expect(canonicalSkill).toContain('Do not maintain a');
    expect(canonicalSkill).toContain('second Pane-generated copy of that lifecycle');
    expect(canonicalSkill).toContain('Treat review feedback as an interrupt owned by the upstream lifecycle');
    expect(canonicalSkill).toContain('routes to `gh-address-comments`');
    expect(canonicalSkill).toContain('rerun stale');
    expect(canonicalSkill).toContain('Delegate discussion to another agent only when the user explicitly asks');
    expect(canonicalSkill).toContain('create a minimal local git repository and register it with Pane');
    expect(canonicalSkill).toContain('Creating a new Pane from a saved repository should normally create an');
    expect(canonicalSkill).toContain('Use extra terminal tabs/panels inside a Pane for clean-context review');
    expect(canonicalSkill).toContain('After a PR is merged, the user can archive the Pane');
    expect(canonicalSkill).toContain('Workflow map source:');
    expect(canonicalSkill).toContain('Skill legend source:');
    expect(canonicalSkill).toContain('pane-work-recap');
    expect(canonicalSkill).toContain('pane-work-prioritizer');
    expect(canonicalSkill).toContain('Do not start implementation panes for those answers');
    expect(canonicalSkill).toContain('Stop before merge, deploy, release creation, publishing, version changes');
    expect(canonicalSkill).not.toContain('PR test automation or prepare-pr only after implementation review passes');
    expect(canonicalSkill).not.toContain('treating a broad brief as a plan is usually too loose');
  });

  it('writes a project-scoped pane-orchestrator rule for Cursor', async () => {
    const manager = new SkillCacheManager();

    await manager.ensurePaneChatGuide();

    const rule = await fs.readFile(manager.cursorPaneOrchestratorRulePath, 'utf8');
    const canonicalSkill = await fs.readFile(manager.paneChatOrchestratorSkillPath, 'utf8');

    expect(normalizePathSeparators(manager.cursorPaneOrchestratorRulePath)).toContain('/.cursor/rules/pane-orchestrator.mdc');
    expect(rule.startsWith('---\n')).toBe(true);
    expect(rule).toContain('alwaysApply: true');
    expect(rule).not.toContain('name: pane-orchestrator');
    expect(rule).toContain('You are an orchestrator, not an implementation worker.');
    expect(rule).toContain(canonicalSkill.split('---\n').slice(2).join('---\n').trim().slice(0, 120));
  });

  it('mirrors cached repository skills into project-scoped Codex and Claude skill roots', async () => {
    const manager = new SkillCacheManager();
    const codexCachedSkill = path.join(manager.cacheRoot, 'parsa', '.codex', 'skills', 'discussion', 'SKILL.md');
    const claudeCachedSkill = path.join(manager.cacheRoot, 'parsa', '.claude', 'skills', 'implement', 'SKILL.md');
    const staleCodexSkill = path.join(manager.codexProjectSkillsRoot, 'stale-skill', 'SKILL.md');

    await fs.mkdir(path.dirname(codexCachedSkill), { recursive: true });
    await fs.writeFile(codexCachedSkill, '# Cached Codex Discussion\n', 'utf8');
    await fs.mkdir(path.dirname(claudeCachedSkill), { recursive: true });
    await fs.writeFile(claudeCachedSkill, '# Cached Claude Implement\n', 'utf8');
    await fs.mkdir(path.dirname(staleCodexSkill), { recursive: true });
    await fs.writeFile(staleCodexSkill, '# Stale\n', 'utf8');

    await manager.ensurePaneChatGuide();

    await expect(
      fs.readFile(path.join(manager.codexProjectSkillsRoot, 'discussion', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Cached Codex Discussion\n');
    await expect(
      fs.readFile(path.join(manager.claudeProjectSkillsRoot, 'implement', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Cached Claude Implement\n');
    await expect(fs.access(staleCodexSkill)).rejects.toThrow();
    await expect(fs.readFile(manager.codexPaneOrchestratorSkillPath, 'utf8')).resolves.toContain(
      'name: pane-orchestrator',
    );
    await expect(fs.readFile(manager.claudePaneOrchestratorSkillPath, 'utf8')).resolves.toContain(
      'name: pane-orchestrator',
    );
  });

  it('downloads required review-feedback fallback skills and mirrors them into project roots', async () => {
    const manager = new SkillCacheManager();
    const httpsGet = mockRawDownloads();

    try {
      await managerDownloads(manager);
      await manager.ensurePaneChatGuide();
    } finally {
      httpsGet.mockRestore();
    }

    await expect(
      fs.readFile(path.join(manager.codexProjectSkillsRoot, 'gh-address-comments', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('parsa/.codex/skills/gh-address-comments/SKILL.md');
    await expect(
      fs.readFile(path.join(manager.codexProjectSkillsRoot, 'gh-address-comments', 'agents', 'openai.yaml'), 'utf8'),
    ).resolves.toContain('parsa/.codex/skills/gh-address-comments/agents/openai.yaml');
    await expect(
      fs.readFile(path.join(manager.claudeProjectSkillsRoot, 'gh-address-comments', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('parsa/.claude/skills/gh-address-comments/SKILL.md');
    await expect(
      fs.readFile(path.join(manager.claudeProjectSkillsRoot, 'gh-address-comments', 'agents', 'openai.yaml'), 'utf8'),
    ).resolves.toContain('parsa/.claude/skills/gh-address-comments/agents/openai.yaml');
    await expect(
      fs.readFile(path.join(manager.claudeProjectSkillsRoot, 'review', 'CRITERIA.md'), 'utf8'),
    ).resolves.toContain('parsa/.claude/skills/review/CRITERIA.md');
  });

  it('fails raw fallback when a required lifecycle file download fails even if a stale file exists', async () => {
    const manager = new SkillCacheManager();
    const requiredPath = 'parsa/.codex/skills/gh-address-comments/SKILL.md';
    const staleTarget = path.join(manager.cacheRoot, requiredPath);
    const httpsGet = mockRawDownloads(new Set([requiredPath]));

    await fs.mkdir(path.dirname(staleTarget), { recursive: true });
    await fs.writeFile(staleTarget, '# stale feedback skill\n', 'utf8');

    try {
      await expect(
        managerDownloads(manager),
      ).rejects.toThrow(`Required download failures: ${requiredPath}`);
    } finally {
      httpsGet.mockRestore();
    }
  });
});
