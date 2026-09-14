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
    expect(guide).toContain('Pane Chat Orchestrator');
    expect(guide).toContain('pane-work-recap');
    expect(guide).toContain('pane-work-prioritizer');
    expect(guide).toContain('runpane-orchestrator');
    expect(guide).toContain('## Hard stops');
    expect(normalizedGuide).toContain('/skills/dcouple/parsa/.claude/skills/runpane-orchestrator/SKILL.md');
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
    expect(watcher).toContain('sys.stdout.reconfigure(encoding="utf-8", errors="replace")');
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
        "process.stdout.write('READY Pane-雪 pane P panel Q\\n');",
        "process.stderr.write('daemon-stderr\\n');",
        'process.exit(3);',
      ].join('\n'));
      const result = spawnSync(pythonExecutable, [manager.paneWatchScriptPath, '--once'], {
        encoding: 'utf8',
        cwd: tempDir,
        env: localCliEnvironment(shimDirectory),
      });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain('READY Pane-雪 pane P panel Q');
      expect(result.stdout).toContain('daemon-stderr');
      expect(result.stdout).toContain('WATCH ERROR child-exit rc=3');
    },
  );

  it.skipIf(process.platform !== 'win32' || pythonProbe.status !== 0)(
    'reports when Windows has no shell-safe launcher',
    async () => {
      const manager = new SkillCacheManager();
      await manager.ensurePaneChatGuide();
      if (!tempDir) throw new Error('expected test temp directory');
      const shimDirectory = path.join(tempDir, 'unsafe-shim-bin');
      await fs.mkdir(shimDirectory, { recursive: true });
      await fs.writeFile(path.join(shimDirectory, 'runpane.cmd'), '@echo off\r\nexit /b 99\r\n', 'utf8');
      const result = spawnSync(pythonExecutable, [manager.paneWatchScriptPath, '--once'], {
        encoding: 'utf8',
        cwd: tempDir,
        env: { ...process.env, PATH: shimDirectory },
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('WATCH ERROR RuntimeError: no safe RunPane launcher found');
      expect(result.stderr).toBe('');
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
    expect(watcher).toContain('sys.stdout.reconfigure(encoding="utf-8", errors="replace")');
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
    const success = spawnSync(pythonExecutable, [manager.paneIdleWatchScriptPath, '--once', 'panel-1:Démo雪'], options);
    expect(success.status).toBe(0);
    expect(success.stdout).toContain('IDLE Démo雪 3m pane pane-real panel panel-1');
    expect(success.stdout).not.toContain('pane Démo雪');
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
    expect(canonicalSkill).toContain('orchestrator, not an implementation worker');
    expect(canonicalSkill).toContain('## Liveness Contract');
    expect(canonicalSkill).toContain('runpane watch --self-test');
    expect(canonicalSkill).toContain('runpane watch --follow');
    expect(canonicalSkill).toContain('READY');
    expect(canonicalSkill).toContain('BLOCKED');
    expect(canonicalSkill).toContain('HEARTBEAT');
    expect(canonicalSkill).toContain('runpane doctor --report');
    expect(canonicalSkill).toContain('do it yourself in this chat');
    expect(canonicalSkill).toContain('cold-read');
    expect(canonicalSkill).toContain('pane-work-recap');
    expect(canonicalSkill).toContain('pane-work-prioritizer');
    expect(canonicalSkill).toContain('## Hard stops');
    expect(canonicalSkill).toContain('runpane-orchestrator');
    expect(canonicalSkill).not.toContain('fresh-eyes');
  });

  it('asks the unattended resilience question and specifies the mode in every emitted variant', async () => {
    const manager = new SkillCacheManager();

    await manager.ensurePaneChatGuide();

    const guide = await fs.readFile(manager.paneChatGuidePath, 'utf8');
    const canonicalSkill = await fs.readFile(manager.paneChatOrchestratorSkillPath, 'utf8');
    const codexSkill = await fs.readFile(manager.codexPaneOrchestratorSkillPath, 'utf8');
    const claudeSkill = await fs.readFile(manager.claudePaneOrchestratorSkillPath, 'utf8');
    const cursorRule = await fs.readFile(manager.cursorPaneOrchestratorRulePath, 'utf8');

    for (const rawVariant of [guide, canonicalSkill, codexSkill, claudeSkill, cursorRule]) {
      const variant = rawVariant.replace(/\s+/g, ' ');
      expect(variant).toContain('Enable unattended resilience for this session?');
      expect(variant).toContain('Default: yes.');
      expect(variant).toContain('treat that as yes and say so in one line');
      expect(variant).toContain('An explicit "no", at any point, disables it for the rest of the session');
      expect(variant).toContain('## Unattended resilience (when enabled)');
      expect(variant).toContain('caffeinate -dims');
      expect(variant).toContain('sudo pmset -c disablesleep 1');
      expect(variant).toContain('sudo pmset -c disablesleep 0');
      expect(variant).toContain('pmset -g custom');
      expect(variant).toContain('warn once if `powernap` or `tcpkeepalive` is 0. Do not change them.');
      expect(variant).toContain('idempotent and fast enough to finish inside one short wake window');
      expect(variant).toContain('pmset -g batt');
      expect(variant).not.toContain('caffeinate cannot stop clamshell');
      expect(variant).toContain('Your computer went to sleep');
      expect(variant).toContain("Can't reach the API server");
      expect(variant).toContain('ENOTFOUND');
      expect(variant).toContain('Agent stalled: no progress');
      expect(variant).toContain('Agent terminated early due to an API error');
      expect(variant).toContain('composer.hasUndeliveredText: false');
      expect(variant).toContain('runpane panels screen --panel <panel-id> --limit 80 --json');
      expect(variant).toContain('runpane panels submit-composer --panel <panel-id> --yes --json');
      expect(variant).toContain('runpane panels submit --panel <panel-id> --text "<message>" --yes --json');
      expect(variant).toContain("printf '\\r' | runpane panels input --panel <panel-id> --input-file - --yes --json");
      expect(variant).toContain('earliest incomplete gate');
      expect(variant).toContain('Never auto-resume a pane that is BLOCKED');
      expect(variant).toContain('more than 3 times in any rolling hour');
      expect(variant).toContain('unless the user asked you to keep all panes moving');
      expect(variant).toContain('Log every resume');
      expect(variant).toContain('never authorizes merge, deploy, release');
      expect(variant).toContain('HEARTBEAT gap over 120s');
      expect(variant).toContain('is a wake, not a dead watch');
      expect(variant).toContain('A STUCK line (held input) belongs to the Liveness Contract');
      expect(variant).toContain('re-run `runpane watch --self-test`');
      expect(variant).toContain('## Hard stops');
    }

    // The question is asked once, after doctor, and the section stays clear of the hard stops.
    expect(guide.indexOf('Run the doctor command')).toBeLessThan(guide.indexOf('Enable unattended resilience'));
    expect(guide.indexOf('runpane watch --self-test')).toBeLessThan(guide.indexOf('Enable unattended resilience'));
    expect(guide.indexOf('## Unattended resilience (when enabled)')).toBeLessThan(guide.indexOf('## Hard stops'));
    expect(canonicalSkill.indexOf('runpane watch --self-test')).toBeLessThan(canonicalSkill.indexOf('Enable unattended resilience'));
    expect(canonicalSkill.indexOf('## Liveness Contract')).toBeLessThan(canonicalSkill.indexOf('## Unattended resilience (when enabled)'));
    expect(canonicalSkill.indexOf('## Unattended resilience (when enabled)')).toBeLessThan(canonicalSkill.indexOf('## Hard stops'));
    expect(canonicalSkill.split('Enable unattended resilience for this session?')).toHaveLength(2);
  });

  it('rewrites stale generated guide and skill files on upgrade', async () => {
    const manager = new SkillCacheManager();
    const targets = [
      manager.paneChatGuidePath,
      manager.paneChatOrchestratorSkillPath,
      manager.codexPaneOrchestratorSkillPath,
      manager.claudePaneOrchestratorSkillPath,
      manager.cursorPaneOrchestratorRulePath,
    ];
    for (const target of targets) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, '# stale pre-upgrade text\n', 'utf8');
    }

    await manager.ensurePaneChatGuide();

    for (const target of targets) {
      const contents = await fs.readFile(target, 'utf8');
      expect(contents).not.toContain('stale pre-upgrade text');
      expect(contents).toContain('## Unattended resilience (when enabled)');
    }
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
