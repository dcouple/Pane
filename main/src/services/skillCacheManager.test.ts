import fs from 'fs/promises';
import { EventEmitter } from 'events';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillCacheManager } from './skillCacheManager';

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function mockRawDownloads(failures = new Set<string>()) {
  return vi.spyOn(https, 'get').mockImplementation((url, callback) => {
    const request = new EventEmitter() as ReturnType<typeof https.get>;
    const pathname = new URL(String(url)).pathname;
    const relativePath = decodeURIComponent(pathname.replace('/dcouple/skills/main/', ''));
    const response = new EventEmitter() as IncomingMessageLike;

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
    expect(canonicalSkill).toContain('must delegate the actual work to a Pane agent or panel through RunPane');
    expect(canonicalSkill).toContain('unless the user explicitly');
    expect(canonicalSkill).toContain('says: "do it yourself in this chat."');
    expect(canonicalSkill).toContain('Inspect the workflow map and skill legend');
    expect(canonicalSkill).toContain('Do not claim initialization is complete');
    expect(canonicalSkill).toContain('## Contract Precedence');
    expect(canonicalSkill).toContain('The generated runtime context is authoritative');
    expect(canonicalSkill).toContain("active agent's cached RunPane orchestrator skill is authoritative");
    expect(canonicalSkill).toContain('persistent authorization ledger');
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
      await (manager as unknown as { downloadFallbackFiles: () => Promise<void> }).downloadFallbackFiles();
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
        (manager as unknown as { downloadFallbackFiles: () => Promise<void> }).downloadFallbackFiles(),
      ).rejects.toThrow(`Required download failures: ${requiredPath}`);
    } finally {
      httpsGet.mockRestore();
    }
  });
});
