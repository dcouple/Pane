import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPaneDaemonHost: vi.fn(),
  usageStart: vi.fn(),
  usageStop: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    dock: { hide: vi.fn() },
    whenReady: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('./bootstrap', () => ({
  createPaneDaemonHost: mocks.createPaneDaemonHost,
}));

vi.mock('../services/usage/usageManager', () => ({
  usageManager: {
    start: mocks.usageStart,
    stop: mocks.usageStop,
  },
}));

vi.mock('../utils/appDirectory', () => ({
  applyAppDirectoryOverrideFromArgs: vi.fn(() => null),
  getAppDirectory: vi.fn(() => '/tmp/pane-headless-test'),
  migrateDataDirectory: vi.fn(),
}));

vi.mock('../utils/consoleWrapper', () => ({
  setupConsoleWrapper: vi.fn(),
}));

describe('startHeadlessPaneProcess', () => {
  beforeEach(() => {
    mocks.createPaneDaemonHost.mockResolvedValue({
      paneDaemonServer: { getEndpoint: () => null },
      shutdown: vi.fn(),
    });
    mocks.usageStart.mockResolvedValue(undefined);
  });

  it('starts transcript indexing after the daemon host is ready', async () => {
    const { startHeadlessPaneProcess } = await import('./startHeadless');

    startHeadlessPaneProcess();

    await vi.waitFor(() => {
      expect(mocks.createPaneDaemonHost).toHaveBeenCalledOnce();
      expect(mocks.usageStart).toHaveBeenCalledOnce();
    });
    expect(mocks.createPaneDaemonHost.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.usageStart.mock.invocationCallOrder[0]);
  });
});
