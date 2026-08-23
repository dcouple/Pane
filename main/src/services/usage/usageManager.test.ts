import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const watcher = {
    on: vi.fn(),
    close: vi.fn(),
  };
  watcher.on.mockReturnValue(watcher);
  return {
    watch: vi.fn(() => watcher),
    watcher,
  };
});

vi.mock('chokidar', () => ({
  default: { watch: mocks.watch },
}));

vi.mock('../database', () => ({
  databaseService: { getDb: vi.fn() },
}));

import { UsageManager } from './usageManager';

describe('UsageManager transcript watchers', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('watches both transcript roots even before a CLI creates them', () => {
    const manager = new UsageManager();

    // Exercise the watcher setup without starting a database scan.
    (manager as unknown as { startWatching(): void }).startWatching();

    expect(mocks.watch).toHaveBeenCalledTimes(2);
    expect(mocks.watch.mock.calls.map(([path]) => String(path))).toEqual([
      expect.stringContaining('.claude'),
      expect.stringContaining('.codex'),
    ]);
    manager.stop();
  });
});
