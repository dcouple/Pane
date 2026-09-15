import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 814, name: 'Dock fixture', path: '/tmp/dock-fixture', active: true, created_at: now, updated_at: now };
const mainSession = {
  id: 'dock-main', name: 'Dock fixture (Main)', projectId: project.id,
  worktreePath: project.path, isMainRepo: true, prompt: '', status: 'stopped',
  createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', toolType: 'none', archived: false, displayOrder: 0,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const otherSession = { ...mainSession, id: 'dock-other', name: 'Other pane', isMainRepo: false, displayOrder: 1 };
const shell = {
  id: 'default-shell', sessionId: mainSession.id, type: 'terminal', title: 'Terminal',
  state: { isActive: true, customState: {} },
  metadata: { createdAt: now, lastActiveAt: now, position: 0 },
};

async function openMainProject(page: Page) {
  await page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await expect(page.locator('.pane-project-content')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading main repository session' })).toHaveCount(0);
}

async function expandRepository(page: Page) {
  await expect(page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true })).toBeVisible();
  const expand = page.getByRole('button', { name: `Expand repository ${project.name}`, exact: true });
  if (await expand.isVisible()) await expand.click();
}

for (const withDock of [false, true]) {
  for (const agent of ['Claude Code', 'Codex']) {
    test(`an empty main repository ${withDock ? 'with' : 'without'} a dock offers and launches ${agent}`, async ({ page }) => {
      await installElectronApiMock(page, {
        initialProjects: [project], initialSessions: [mainSession],
        initialPanels: withDock ? [shell] : [], activeProjectId: project.id,
      });
      await page.goto('/');
      await openMainProject(page);
      const stage = page.locator('.pane-project-content .pane-center-column > div').first();
      for (const label of ['Terminal', 'Claude Code', 'Codex']) {
        await expect(stage.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
      }
      await stage.getByRole('button', { name: new RegExp(`^${agent}`) }).click();
      await expect(page.getByRole('tab', { name: agent, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(stage.getByRole('button', { name: /^Codex/ })).toHaveCount(0);
      const result = await page.evaluate(async id => window.electronAPI.panels.getSessionPanels(id), mainSession.id);
      expect(result.data?.find(panel => panel.title === agent)?.state.customState).toMatchObject({
        initialCommand: agent === 'Codex' ? 'codex --yolo' : 'claude --dangerously-skip-permissions',
      });
      await page.getByRole('button', { name: `Close ${agent}`, exact: true }).click();
      await expect(stage.getByRole('button', { name: /^Codex/ })).toBeVisible();
      await expect(page.locator('.pane-terminal-dock')).toHaveCount(withDock ? 1 : 0);
    });
  }
}

test('the main repository shell starts in an expanded bottom dock with no top tab', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [mainSession, otherSession],
    initialPanels: [shell], activeProjectId: project.id,
  });
  await page.goto('/');
  await openMainProject(page);
  await expect(page.locator('.pane-terminal-dock .pane-terminal-shell-body')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveCount(0);
  await expect(page.locator('.panel-tab-bar [role="tab"]')).toHaveCount(0);

  await expandRepository(page);
  await page.getByRole('button', { name: otherSession.name, exact: true }).click();
  await page.getByRole('button', { name: mainSession.name, exact: true }).click();
  await expect(page.locator('.pane-terminal-dock .pane-terminal-shell-body')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveCount(0);
});

for (const agent of ['Codex', 'Claude Code']) {
  test(`${agent} stays a top tab after returning to a main pane whose shell was removed`, async ({ page }) => {
    await installElectronApiMock(page, {
      initialProjects: [project], initialSessions: [mainSession, otherSession],
      initialPanels: [shell], activeProjectId: project.id,
      // Old persisted layouts omitted the agent when it was mistaken for the dock.
      initialLayout: {
        version: 1, focusedGroupId: 'empty',
        root: { type: 'group', id: 'empty', panelIds: [], activePanelId: null },
      },
    });
    await page.addInitScript(() => localStorage.setItem('pane-terminal-collapsed', 'true'));
    await page.goto('/');
    await openMainProject(page);
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(page.locator('.pane-terminal-dock')).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide details', exact: true }).click();
    await page.getByRole('button', { name: 'Add tool', exact: true }).click();
    await page.getByRole('menuitem', { name: new RegExp(agent) }).click();
    const tab = page.getByRole('tab', { name: agent, exact: true });
    await expect(tab).toBeVisible();
    const tabId = await tab.getAttribute('id');

    await expandRepository(page);
    await page.getByRole('button', { name: otherSession.name, exact: true }).click();
    await page.getByRole('button', { name: mainSession.name, exact: true }).click();
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('id', tabId!);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.pane-terminal-dock')).toHaveCount(0);

    // New agents created directly in SessionView must also enter the layout.
    await page.getByRole('button', { name: 'Add tool', exact: true }).click();
    await page.getByRole('menuitem', { name: /Cursor/ }).click();
    await expect(page.getByRole('tab', { name: 'Cursor', exact: true })).toBeVisible();

    // Loading the same main session through the project entry must agree.
    await openMainProject(page);
    await expect(tab).toBeVisible();
    await expect(page.locator('.pane-terminal-dock')).toHaveCount(0);

    // Reopening a shell expands the dock, and closing it leaves the active agent alone.
    await page.getByRole('button', { name: 'Add tool', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Terminal/ }).click();
    await expect(page.locator('.pane-terminal-dock .pane-terminal-shell-body')).toBeVisible();
    const cursorTab = page.getByRole('tab', { name: 'Cursor', exact: true });
    await cursorTab.click();
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(cursorTab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toBeVisible();
  });
}

test('a restored agent identified only by runtime metadata stays out of the dock', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [mainSession], activeProjectId: project.id,
    initialPanels: [{ ...shell, id: 'restored-agent', title: 'Codex', state: { isActive: true, customState: { agentType: 'codex', isCliPanel: true } } }],
    initialLayout: {
      version: 1, focusedGroupId: 'empty',
      root: { type: 'group', id: 'empty', panelIds: [], activePanelId: null },
    },
  });
  await page.goto('/');
  await expandRepository(page);
  await page.getByRole('button', { name: mainSession.name, exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();
  await expect(page.locator('.pane-terminal-dock')).toHaveCount(0);
});

test('a fresh worktree profile defaults to an expanded dock and preserves an explicit collapse', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [otherSession], activeProjectId: project.id,
    initialPanels: [{ ...shell, sessionId: otherSession.id }],
  });
  await page.goto('/');
  await expandRepository(page);
  await page.getByRole('button', { name: otherSession.name, exact: true }).click();
  await expect(page.locator('.pane-terminal-shell-body')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pane-terminal-collapsed'))).toBe('false');
  await page.getByRole('button', { name: 'Collapse terminal', exact: true }).click();
  await page.reload();
  await expandRepository(page);
  await page.getByRole('button', { name: otherSession.name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand terminal', exact: true })).toBeVisible();
  await expect(page.locator('.pane-terminal-shell-body')).toHaveCount(0);
});

for (const { deletion, split } of [
  { deletion: 'dock button', split: false },
  { deletion: 'backend event', split: false },
  { deletion: 'dock button', split: true },
  { deletion: 'backend event', split: true },
]) {
  test(`promoting a shell via ${deletion} repairs the ${split ? 'split' : 'single'} layout and persists selection`, async ({ page }) => {
    const extraShell = { ...shell, id: 'extra-shell', title: 'Extra shell', state: { isActive: true, customState: {} } };
    const agent = { ...shell, id: 'codex', title: 'Codex', state: { isActive: false, customState: { initialCommand: 'codex --yolo' } } };
    await installElectronApiMock(page, {
      initialProjects: [project], initialSessions: [mainSession, otherSession], activeProjectId: project.id,
      initialPanels: [{ ...shell, state: { isActive: false, customState: {} } }, extraShell, agent],
      initialLayout: split ? {
        version: 1, focusedGroupId: 'shell-group', zoomedGroupId: 'shell-group',
        root: {
          type: 'split', id: 'split', direction: 'row', sizes: [1, 1],
          children: [
            { type: 'group', id: 'shell-group', panelIds: [extraShell.id], activePanelId: extraShell.id },
            { type: 'group', id: 'agent-group', panelIds: [agent.id], activePanelId: agent.id },
          ],
        },
      } : {
        version: 1, focusedGroupId: 'agent-group',
        root: { type: 'group', id: 'agent-group', panelIds: [extraShell.id, agent.id], activePanelId: extraShell.id },
      },
    });
    await page.goto('/');
    await expandRepository(page);
    await page.getByRole('button', { name: mainSession.name, exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Extra shell', exact: true })).toBeVisible();

    if (deletion === 'dock button') {
      await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
    } else {
      await page.evaluate(id => window.electronAPI.panels.deletePanel(id), shell.id);
    }

    const codexTab = page.getByRole('tab', { name: 'Codex', exact: true });
    await expect(codexTab).toBeVisible();
    await expect(codexTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Codex', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Extra shell', exact: true })).toHaveCount(0);
    await expect(page.locator('.pane-terminal-dock')).toBeVisible();

    await expect.poll(() => page.evaluate(async id => {
      return (await window.electronAPI.invoke('panels:get-layout', id)).data;
    }, mainSession.id)).toEqual({
      version: 1, focusedGroupId: 'agent-group', zoomedGroupId: null,
      root: { type: 'group', id: 'agent-group', panelIds: [agent.id], activePanelId: agent.id },
    });
    await page.getByRole('button', { name: otherSession.name, exact: true }).click();
    await page.getByRole('button', { name: mainSession.name, exact: true }).click();
    await expect(codexTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Codex', exact: true })).toBeVisible();
  });
}

test('opening a project preserves a non-first persisted active tab', async ({ page }) => {
  const agents = ['Codex', 'Claude Code', 'Cursor'].map((title, index) => ({
    ...shell, id: `agent-${index}`, title,
    state: { isActive: title === 'Cursor', customState: { initialCommand: title } },
  }));
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [mainSession, otherSession], activeProjectId: project.id,
    initialPanels: [{ ...shell, state: { isActive: false, customState: {} } }, ...agents],
  });
  await page.goto('/');
  await openMainProject(page);
  const cursorTab = page.getByRole('tab', { name: 'Cursor', exact: true });
  const stage = page.locator('.pane-project-content .pane-center-column > div').first();
  await expect(cursorTab).toHaveAttribute('aria-selected', 'true');
  await expect(stage.locator('.xterm:visible')).toHaveCount(1);
  await expect.poll(() => page.evaluate(async id => {
    const result = await window.electronAPI.panels.getSessionPanels(id);
    return result.data?.find(panel => panel.state.isActive)?.title;
  }, mainSession.id)).toBe('Cursor');

  await expandRepository(page);
  await page.getByRole('button', { name: otherSession.name, exact: true }).click();
  await openMainProject(page);
  await expect(cursorTab).toHaveAttribute('aria-selected', 'true');
  await expect(stage.locator('.xterm:visible')).toHaveCount(1);
});

test('project fallback selection agrees with the backend when the active panel belongs to the dock', async ({ page }) => {
  const agent = { ...shell, id: 'codex', title: 'Codex', state: { isActive: false, customState: { initialCommand: 'codex --yolo' } } };
  const secondAgent = { ...agent, id: 'claude', title: 'Claude Code', state: { isActive: false, customState: { initialCommand: 'claude' } } };
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [mainSession], activeProjectId: project.id,
    initialPanels: [shell, agent, secondAgent],
  });
  await page.goto('/');
  await openMainProject(page);
  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(async id => {
    const result = await window.electronAPI.panels.getSessionPanels(id);
    return result.data?.find(panel => panel.state.isActive)?.id;
  }, mainSession.id)).toBe(agent.id);

  // SessionView remains mounted around ProjectView and handles backend deletion events.
  await page.evaluate(id => window.electronAPI.panels.deletePanel(id), agent.id);
  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(async id => {
    const result = await window.electronAPI.panels.getSessionPanels(id);
    return result.data?.find(panel => panel.state.isActive)?.id;
  }, mainSession.id)).toBe(secondAgent.id);
});
