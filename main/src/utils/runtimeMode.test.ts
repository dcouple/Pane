import { describe, expect, it } from 'vitest';
import { hasHeadlessDaemonLaunchArg } from './runtimeMode';

describe('hasHeadlessDaemonLaunchArg', () => {
  it('detects the primary headless daemon flag', () => {
    expect(hasHeadlessDaemonLaunchArg(['--daemon-headless'])).toBe(true);
  });

  it('accepts the legacy alias', () => {
    expect(hasHeadlessDaemonLaunchArg(['--headless-daemon'])).toBe(true);
  });

  it('ignores unrelated args', () => {
    expect(hasHeadlessDaemonLaunchArg(['--pane-dir', '/tmp/pane'])).toBe(false);
  });
});
