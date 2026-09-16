import { expect, test, type Page } from '@playwright/test';
import type { ChangedFileSummary, DiffManifest, DiffScope, FileDiffResult } from '../shared/types/gitDiff';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';
import { expectNoAxeViolations } from './axeTest';

const timestamp = new Date(0).toISOString();
const project = { id: 812, name: 'Tree fixture', path: '/tmp/tree-fixture', active: true, created_at: timestamp, updated_at: timestamp };
const session = {
  id: 'tree-session',
  name: 'Changes tree',
  worktreePath: '/tmp/tree-fixture/worktree',
  status: 'stopped',
  createdAt: timestamp,
  lastActivity: timestamp,
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  gitStatus: { state: 'modified', ahead: 2, behind: 0, hasUncommittedChanges: true, hasUntrackedFiles: false, filesChanged: 6, additions: 9, deletions: 4, totalCommits: 2 },
};

const panelsFor = (target: typeof session) => [
  { id: `${target.id}-terminal`, sessionId: target.id, type: 'terminal', title: 'Terminal', state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } }, metadata: { createdAt: timestamp, lastActiveAt: timestamp, position: 0, permanent: true } },
  { id: `${target.id}-diff`, sessionId: target.id, type: 'diff', title: 'Diff', state: { isActive: false, hasBeenViewed: true }, metadata: { createdAt: timestamp, lastActiveAt: timestamp, position: 1, permanent: true } },
];
const panels = panelsFor(session);

const changed = (path: string, overrides: Partial<ChangedFileSummary> = {}): ChangedFileSummary => ({
  path,
  kind: 'modified',
  additions: 1,
  deletions: 1,
  isBinary: false,
  ...overrides,
});

function createManifest(scope: DiffScope, files: ChangedFileSummary[]): DiffManifest {
  return {
    scope,
    files,
    resolvedBase: scope.kind === 'session'
      ? { kind: 'comparison-base', ref: 'main', hash: '1111111111111111111111111111111111111111' }
      : { kind: 'commit', hash: '2222222222222222222222222222222222222222' },
    resolvedTarget: scope.kind === 'working-tree' || scope.kind === 'working-tree-range' || scope.kind === 'session'
      ? { kind: 'working-tree' }
      : { kind: 'commit', hash: '3333333333333333333333333333333333333333' },
    stats: {
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      filesChanged: files.length,
    },
  };
}

const manifest = createManifest({ kind: 'session' }, [
  changed('src/components/Alpha.tsx', { additions: 2 }),
  changed('src/components/Beta.tsx', { previousPath: 'src/legacy/Beta.tsx', kind: 'renamed', additions: 0, deletions: 0 }),
  changed('src/renamed-edit.ts', { previousPath: 'src/old-edit.ts', kind: 'renamed', additions: 1, deletions: 1 }),
  changed('src/deleted.ts', { kind: 'deleted', additions: 0 }),
  changed('assets/image.bin', { additions: null, deletions: null, isBinary: true }),
  changed('README.md', { kind: 'added', additions: 4, deletions: 0 }),
]);

const execution = (id: number, hash: string, message: string): JsonObject => ({
  id,
  session_id: session.id,
  execution_sequence: id,
  after_commit_hash: hash,
  commit_message: message,
  timestamp,
  stats_additions: 1,
  stats_deletions: 0,
  stats_files_changed: 1,
});

interface OpenTreeOptions {
  executions?: JsonObject[];
  manifests?: Record<string, DiffManifest>;
  manifestDelays?: Record<string, number>;
  fileDiffs?: Record<string, FileDiffResult>;
  fileDelays?: Record<string, number>;
  sessions?: JsonObject[];
  panels?: JsonObject[];
  gitCommands?: JsonObject;
  waitForTree?: boolean;
}

async function openTree(page: Page, options: OpenTreeOptions = {}): Promise<void> {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: options.sessions ?? [session],
    initialPanels: options.panels ?? panels,
    initialExecutions: options.executions ?? [],
    diffManifests: options.manifests ?? { session: manifest },
    diffManifestDelayMs: options.manifestDelays,
    fileDiffs: options.fileDiffs,
    fileDiffDelayMs: options.fileDelays,
    gitCommands: options.gitCommands,
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/');
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  if (options.waitForTree !== false) await expect(page.getByRole('tree', { name: 'Changed files' })).toBeVisible();
}

interface DiffMockController {
  getDiffManifestCalls(): Array<{ sessionId: string; scope: DiffScope }>;
  getFileDiffCalls(): Array<{ sessionId: string; scope: DiffScope; path: string }>;
}

const manifestCalls = (page: Page) => page.evaluate(() => {
  // SAFETY: installElectronApiMock defines this controller before application code runs.
  const mockWindow = window as typeof window & { __paneTestElectronMock: DiffMockController };
  return mockWindow.__paneTestElectronMock.getDiffManifestCalls();
});
const fileDiffCalls = (page: Page) => page.evaluate(() => {
  // SAFETY: installElectronApiMock defines this controller before application code runs.
  const mockWindow = window as typeof window & { __paneTestElectronMock: DiffMockController };
  return mockWindow.__paneTestElectronMock.getFileDiffCalls();
});

test('hierarchy and tree-only controls remain accessible', async ({ page }) => {
  await openTree(page);
  await expect(page.getByRole('treeitem', { name: 'Open diff for README.md' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Open diff for src/components/Alpha.tsx' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /Open diff for src\/components\/Alpha.tsx, Modified, \+2 −1/ })).toBeVisible();
  await expect(page.getByText(/stage|unstage|list view|tree view/i)).toHaveCount(0);
  await expectNoAxeViolations(page, { include: '.combined-diff-view' });
});

test('keyboard navigation pins the exact expected row for every key branch', async ({ page }) => {
  const keyboardManifest = createManifest({ kind: 'session' }, [
    changed('alpha/one.ts'),
    changed('alpha/two.ts'),
    changed('root.ts'),
    changed('zeta.ts'),
  ]);
  await openTree(page, { manifests: { session: keyboardManifest } });
  const tree = page.getByRole('tree', { name: 'Changed files' });
  const active = () => page.locator('.pane-changes-tree-row.is-active');

  await tree.focus();
  await tree.press('Home');
  await expect(active()).toHaveAttribute('aria-label', 'alpha');
  await tree.press('ArrowRight');
  await expect(active()).toHaveAttribute('aria-label', /Open diff for alpha\/one.ts/);
  await tree.press('ArrowDown');
  await expect(active()).toHaveAttribute('aria-label', /Open diff for alpha\/two.ts/);
  await tree.press('ArrowUp');
  await expect(active()).toHaveAttribute('aria-label', /Open diff for alpha\/one.ts/);
  await tree.press('ArrowLeft');
  await expect(active()).toHaveAttribute('aria-label', 'alpha');
  await tree.press('ArrowLeft');
  await expect(active()).toHaveAttribute('aria-expanded', 'false');
  await tree.press('ArrowRight');
  await expect(active()).toHaveAttribute('aria-expanded', 'true');
  await tree.press('ArrowRight');
  await expect(active()).toHaveAttribute('aria-label', /Open diff for alpha\/one.ts/);
  await tree.press('End');
  await expect(active()).toHaveAttribute('aria-label', /Open diff for zeta.ts/);
  await tree.press('Home');
  await expect(active()).toHaveAttribute('aria-label', 'alpha');
  await tree.press('r');
  await expect(active()).toHaveAttribute('aria-label', /Open diff for root.ts/);
});

test('does not fetch file content before activation and opens every special tab state', async ({ page }) => {
  const renamedPatch = 'diff --git a/src/old-edit.ts b/src/renamed-edit.ts\n--- a/src/old-edit.ts\n+++ b/src/renamed-edit.ts\n@@ -1 +1 @@\n-before\n+after rename\n';
  await openTree(page, {
    fileDiffs: {
      'session:src/renamed-edit.ts': { file: manifest.files[2], patch: renamedPatch, status: 'changed' },
      'session:src/deleted.ts': { file: manifest.files[3], patch: 'diff --git a/src/deleted.ts b/src/deleted.ts\n--- a/src/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n', status: 'changed' },
      'session:assets/image.bin': { file: manifest.files[4], patch: 'Binary files differ', status: 'changed' },
      'session:src/components/Beta.tsx': { file: manifest.files[1], patch: 'diff --git a/src/legacy/Beta.tsx b/src/components/Beta.tsx\nsimilarity index 100%\nrename from src/legacy/Beta.tsx\nrename to src/components/Beta.tsx\n', status: 'changed' },
    },
  });

  expect(await fileDiffCalls(page)).toHaveLength(0);

  await page.getByRole('treeitem', { name: 'Open diff for src/renamed-edit.ts' }).click();
  await expect(page.getByRole('tab', { name: 'renamed-edit.ts (All changes)' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('after rename', { exact: true })).toBeVisible();

  await page.getByRole('treeitem', { name: 'Open diff for src/deleted.ts' }).click();
  await expect(page.getByRole('button', { name: 'Open src/deleted.ts in Editor' })).toHaveCount(0);

  await page.getByRole('treeitem', { name: 'Open diff for assets/image.bin' }).click();
  await expect(page.getByText('Binary file', { exact: true })).toBeVisible();

  await page.getByRole('treeitem', { name: 'Open diff for src/components/Beta.tsx' }).click();
  await expect(page.getByText('Renamed from src/legacy/Beta.tsx → src/components/Beta.tsx, no content changes', { exact: true })).toBeVisible();
});

test('new file keys show loading and late file responses cannot replace the active preview', async ({ page }) => {
  const raceManifest = createManifest({ kind: 'session' }, [
    changed('race/seed.ts', { kind: 'renamed', previousPath: 'race/seed-old.ts', additions: 0, deletions: 0 }),
    changed('race/a.ts', { kind: 'renamed', previousPath: 'race/a-old.ts', additions: 0, deletions: 0 }),
    changed('race/b.ts', { kind: 'renamed', previousPath: 'race/b-old.ts', additions: 0, deletions: 0 }),
  ]);
  const renameResult = (index: number): FileDiffResult => ({ file: raceManifest.files[index], patch: 'rename metadata only', status: 'changed' });
  await openTree(page, {
    manifests: { session: raceManifest },
    fileDiffs: {
      'session:race/seed.ts': renameResult(0),
      'session:race/a.ts': renameResult(1),
      'session:race/b.ts': renameResult(2),
    },
    fileDelays: { 'session:race/a.ts': 160 },
  });

  await page.getByRole('treeitem', { name: 'Open diff for race/seed.ts' }).click();
  await expect(page.getByText('Renamed from race/seed-old.ts → race/seed.ts, no content changes', { exact: true })).toBeVisible();
  await page.getByRole('treeitem', { name: 'Open diff for race/a.ts' }).click();
  await expect(page.getByText('race/a.ts', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading diff…', { exact: true })).toBeVisible();
  await expect(page.getByText('Renamed from race/seed-old.ts → race/seed.ts, no content changes', { exact: true })).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'Open diff for race/b.ts' }).click();
  await expect(page.getByText('Renamed from race/b-old.ts → race/b.ts, no content changes', { exact: true })).toBeVisible();
  await page.waitForTimeout(190);
  await expect(page.getByText('Renamed from race/b-old.ts → race/b.ts, no content changes', { exact: true })).toBeVisible();
  await expect(page.getByText('Renamed from race/a-old.ts → race/a.ts, no content changes', { exact: true })).toHaveCount(0);
});

test('cache ownership settles loading and refresh invalidates only mutable scopes', async ({ page }) => {
  const hashA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hashB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const commitA = createManifest({ kind: 'commit', hash: hashA }, [changed('commit-a.ts')]);
  const commitB = createManifest({ kind: 'commit', hash: hashB }, [changed('commit-b.ts')]);
  const workingTree = createManifest({ kind: 'working-tree' }, [changed('uncommitted-cache.ts')]);
  const workingRange = createManifest({ kind: 'working-tree-range', baseHash: hashA }, [changed('range-working.ts')]);
  const executions = [
    execution(0, 'UNCOMMITTED', 'Uncommitted changes'),
    execution(1, hashB, 'Commit B'),
    execution(2, hashA, 'Commit A'),
  ];
  await openTree(page, {
    executions,
    manifests: {
      session: manifest,
      'working-tree': workingTree,
      [`commit:${hashA}`]: commitA,
      [`commit:${hashB}`]: commitB,
      [`working-range:${hashA}`]: workingRange,
    },
    manifestDelays: { [`commit:${hashB}`]: 150 },
  });
  const review = page.locator('.combined-diff-view');
  const refresh = review.getByTitle('Refresh');

  await page.getByRole('button', { name: 'Select Commit A' }).click();
  await expect(page.getByRole('treeitem', { name: 'Open diff for commit-a.ts' })).toBeVisible();
  await page.getByRole('button', { name: 'Select Commit B' }).click();
  await page.waitForTimeout(20);
  await page.getByRole('button', { name: 'Select Commit A' }).click();
  await expect(page.getByRole('treeitem', { name: 'Open diff for commit-a.ts' })).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(refresh.locator('svg')).not.toHaveClass(/animate-spin/);

  await refresh.click();
  await page.waitForTimeout(30);
  expect((await manifestCalls(page)).filter(call => call.scope.kind === 'commit' && call.scope.hash === hashA)).toHaveLength(1);

  await page.getByRole('button', { name: 'Select uncommitted changes' }).click();
  await expect(page.getByRole('treeitem', { name: 'Open diff for uncommitted-cache.ts' })).toBeVisible();
  const sessionCallsBeforeRefresh = (await manifestCalls(page)).filter(call => call.scope.kind === 'session').length;
  const workingTreeCallsBeforeRefresh = (await manifestCalls(page)).filter(call => call.scope.kind === 'working-tree').length;
  await refresh.click();
  await expect.poll(async () => (await manifestCalls(page)).filter(call => call.scope.kind === 'working-tree').length).toBe(workingTreeCallsBeforeRefresh + 1);
  await page.getByRole('button', { name: 'All changes' }).click();
  await expect(page.getByRole('treeitem', { name: 'Open diff for README.md' })).toBeVisible();
  await expect.poll(async () => (await manifestCalls(page)).filter(call => call.scope.kind === 'session').length).toBe(sessionCallsBeforeRefresh + 1);

  await page.getByRole('button', { name: 'Select Commit A' }).click();
  await expect(page.getByRole('treeitem', { name: 'Open diff for commit-a.ts' })).toBeVisible();
  expect((await manifestCalls(page)).filter(call => call.scope.kind === 'commit' && call.scope.hash === hashA)).toHaveLength(1);
  await page.getByRole('button', { name: 'Select uncommitted changes' }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('treeitem', { name: 'Open diff for range-working.ts' })).toBeVisible();
  const rangeCallsBeforeRefresh = (await manifestCalls(page)).filter(call => call.scope.kind === 'working-tree-range').length;
  await refresh.click();
  await expect.poll(async () => (await manifestCalls(page)).filter(call => call.scope.kind === 'working-tree-range').length).toBe(rangeCallsBeforeRefresh + 1);
});

test('selection scopes and diff:view-commit handoff preserve legacy journeys', async ({ page }) => {
  const newerHash = 'abcdef0123456789abcdef0123456789abcdef01';
  const olderHash = '1234567890abcdef1234567890abcdef12345678';
  const workingTree = createManifest({ kind: 'working-tree' }, [changed('uncommitted-only.ts')]);
  const commitRange = createManifest({ kind: 'commit-range', olderHash, newerHash }, [changed('commit-range.ts')]);
  const workingRange = createManifest({ kind: 'working-tree-range', baseHash: olderHash }, [changed('working-range.ts')]);
  const shortCommit = createManifest({ kind: 'commit', hash: newerHash.slice(0, 7) }, [changed('handoff-commit.ts')]);
  await openTree(page, {
    executions: [
      execution(0, 'UNCOMMITTED', 'Uncommitted changes'),
      execution(1, newerHash, 'Newer commit'),
      execution(2, olderHash, 'Older commit'),
    ],
    manifests: {
      session: manifest,
      'working-tree': workingTree,
      [`range:${olderHash}:${newerHash}`]: commitRange,
      [`working-range:${olderHash}`]: workingRange,
      [`commit:${newerHash.slice(0, 7)}`]: shortCommit,
    },
  });

  await page.getByRole('button', { name: 'Select uncommitted changes' }).click();
  await expect(page.getByRole('treeitem', { name: 'Open diff for uncommitted-only.ts' })).toBeVisible();

  await page.getByRole('button', { name: 'Select Older commit' }).click();
  await page.getByRole('button', { name: 'Select Newer commit' }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('treeitem', { name: 'Open diff for commit-range.ts' })).toBeVisible();

  await page.getByRole('button', { name: 'Select Older commit' }).click();
  await page.getByRole('button', { name: 'Select uncommitted changes' }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('treeitem', { name: 'Open diff for working-range.ts' })).toBeVisible();

  await page.evaluate(({ sessionId, commitHash }) => window.dispatchEvent(new CustomEvent('diff:view-commit', { detail: { sessionId, commitHash } })), {
    sessionId: session.id,
    commitHash: newerHash.slice(0, 7),
  });
  await expect(page.getByRole('treeitem', { name: 'Open diff for handoff-commit.ts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select Newer commit' })).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(sessionId => window.dispatchEvent(new CustomEvent('diff:view-commit', { detail: { sessionId, commitHash: 'index' } })), session.id);
  await expect(page.getByRole('treeitem', { name: 'Open diff for uncommitted-only.ts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select uncommitted changes' })).toHaveAttribute('aria-pressed', 'true');
});

test('switching sessions cannot show rows from the previous session', async ({ page }) => {
  const secondSession = { ...session, id: 'second-session', name: 'Second changes', worktreePath: '/tmp/tree-fixture/second', displayOrder: 1 };
  const oldHash = '9999999999999999999999999999999999999999';
  const oldCommit = createManifest({ kind: 'commit', hash: oldHash }, [changed('first-commit-only.ts')]);
  const secondManifest = createManifest({ kind: 'session' }, [changed('second-only.ts')]);
  await openTree(page, {
    sessions: [session, secondSession],
    panels: [...panels, ...panelsFor(secondSession)],
    executions: [execution(1, oldHash, 'First session commit')],
    manifests: {
      [`${session.id}:session`]: manifest,
      [`${session.id}:commit:${oldHash}`]: oldCommit,
      [`${secondSession.id}:session`]: secondManifest,
    },
  });
  await expect(page.getByRole('treeitem', { name: 'Open diff for README.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Select First session commit' }).click();
  await expect(page.getByRole('treeitem', { name: 'Open diff for first-commit-only.ts' })).toBeVisible();

  await page.getByRole('button', { name: secondSession.name, exact: true }).click();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'Open diff for second-only.ts' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Open diff for README.md' })).toHaveCount(0);
  expect((await manifestCalls(page)).filter(call => call.sessionId === secondSession.id && call.scope.kind === 'commit')).toHaveLength(0);
});

test('inspector width matrix keeps basename and status visible without horizontal overflow', async ({ page }) => {
  // AC8 is about the inspector rail's width, not the window's: the window stays
  // regular and the persisted rail width varies from its minimum to wide.
  await openTree(page);
  for (const width of [240, 360, 580, 700]) {
    // The unloading page persists its own width, so the preference must be
    // written after unload and before boot: an init script, re-registered per
    // iteration (they accumulate; the latest registration runs last and wins).
    await page.addInitScript(value => localStorage.setItem('pane-detail-panel-width:v2', JSON.stringify({ version: 2, preferredPx: value })), width);
    await page.reload();
    await page.getByRole('button', { name: session.name, exact: true }).click();
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    const row = page.getByRole('treeitem', { name: 'Open diff for assets/image.bin' });
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator('.pane-changes-tree-label')).toHaveText('image.bin');
    await expect(row.locator('.pane-changes-tree-status')).toBeVisible();
    const hostBox = await page.locator('.pane-inspector-host:visible').boundingBox();
    // The rail honors the preference up to the app's own cap (window minus the
    // center's reserve), so wide requests may land below the asked width.
    expect(hostBox && hostBox.width).toBeGreaterThanOrEqual(Math.min(width, 580) - 16);
    expect(hostBox && hostBox.width).toBeLessThanOrEqual(width + 16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
for (const scenario of [
  {
    name: 'remote branch',
    gitCommands: { originBranch: 'origin/main', comparisonBaseBranch: 'main' },
    header: 'origin/main · All changes · vs main',
    empty: 'No commits ahead of origin/main',
  },
  {
    name: 'local fallback',
    gitCommands: { originBranch: null, comparisonBaseBranch: 'main' },
    header: 'Local commits · All changes · vs main',
    empty: 'Origin remote not found; showing recent local commits',
  },
] as const) {
  test(`main-repo ${scenario.name} copy remains available`, async ({ page }) => {
    const mainSession = { ...session, isMainRepo: true };
    const emptyManifest = createManifest({ kind: 'session' }, []);
    await openTree(page, {
      sessions: [mainSession],
      panels: panelsFor(mainSession),
      manifests: { session: emptyManifest },
      gitCommands: scenario.gitCommands,
      waitForTree: false,
    });

    await expect(page.getByText(scenario.header, { exact: true })).toBeVisible();
    await expect(page.getByText(scenario.empty, { exact: true })).toBeVisible();
  });
}

test('a late commit manifest cannot replace a restored All changes scope', async ({ page }) => {
  const hash = 'fedcba9876543210fedcba9876543210fedcba98';
  const commitManifest = createManifest({ kind: 'commit', hash }, [changed('commit-only.ts')]);
  await openTree(page, {
    executions: [execution(1, hash, 'Commit scope')],
    manifests: { session: manifest, [`commit:${hash}`]: commitManifest },
    manifestDelays: { [`commit:${hash}`]: 120 },
  });
  await page.getByRole('button', { name: 'Select Commit scope' }).click();
  await page.waitForTimeout(20);
  await page.getByRole('button', { name: 'All changes' }).click();
  await page.waitForTimeout(150);
  await expect(page.getByRole('treeitem', { name: 'Open diff for README.md' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Open diff for commit-only.ts' })).toHaveCount(0);
});

test('active file selection is scope-gated, a manual collapse sticks, and refocus reveals', async ({ page }) => {
  const hashA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitA = createManifest({ kind: 'commit', hash: hashA }, [changed('src/components/Alpha.tsx')]);
  await openTree(page, {
    executions: [execution(1, hashA, 'Commit A')],
    manifests: { session: manifest, [`commit:${hashA}`]: commitA },
    fileDiffs: {
      'session:src/components/Alpha.tsx': { file: manifest.files[0], patch: 'diff --git a/src/components/Alpha.tsx b/src/components/Alpha.tsx\n--- a/src/components/Alpha.tsx\n+++ b/src/components/Alpha.tsx\n@@ -1 +1 @@\n-alpha\n+alpha session\n', status: 'changed' },
    },
  });
  const alpha = page.getByRole('treeitem', { name: 'Open diff for src/components/Alpha.tsx' });
  const components = page.getByRole('treeitem', { name: 'components', exact: true });

  await alpha.click();
  await expect(page.getByRole('tab', { name: 'Alpha.tsx (All changes)' })).toHaveAttribute('aria-selected', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');

  await components.click();
  await expect(components).toHaveAttribute('aria-expanded', 'false');
  await expect(alpha).toHaveCount(0);

  await page.getByRole('tab', { name: 'Alpha.tsx (All changes)' }).focus();
  await page.getByRole('tree', { name: 'Changed files' }).focus();
  await expect(components).toHaveAttribute('aria-expanded', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');

  await components.click();
  await expect(alpha).toHaveCount(0);

  await page.getByRole('button', { name: 'Select Commit A' }).click();
  await expect(alpha).toBeVisible();
  await expect(alpha).toHaveAttribute('aria-selected', 'false');

  await page.getByRole('button', { name: 'All changes', exact: true }).click();
  await expect(components).toHaveAttribute('aria-expanded', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
});

test('a wide persisted commits pane cannot squeeze the tree out of a side-by-side split', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('diff-panel-sidebar-width', '600');
    localStorage.setItem('pane-detail-panel-width:v2', JSON.stringify({ version: 2, preferredPx: 700 }));
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openTree(page);
  const split = page.locator('.pane-review-split');
  const list = page.locator('.pane-review-list');
  const splitBox = await split.boundingBox();
  const listBox = await list.boundingBox();
  const stacked = await split.evaluate(element => getComputedStyle(element).flexDirection === 'column');
  expect(stacked).toBe(false);
  expect(splitBox && listBox && listBox.width).toBeLessThanOrEqual((splitBox?.width ?? 0) - 239);
  const treeBox = await page.getByRole('tree', { name: 'Changed files' }).boundingBox();
  expect(treeBox && treeBox.width).toBeGreaterThanOrEqual(200);
  // The panel fills the inspector rail instead of sizing to its content.
  const hostBox = await page.locator('.pane-inspector-host:visible').boundingBox();
  const viewBox = await page.locator('.combined-diff-view').boundingBox();
  expect(hostBox && viewBox && viewBox.width).toBeGreaterThanOrEqual((hostBox?.width ?? 0) - 8);
  await expect(page.getByRole('treeitem', { name: 'Open diff for README.md' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
