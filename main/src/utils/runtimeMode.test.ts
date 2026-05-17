import { describe, expect, it } from 'vitest';
import { hasHeadlessDaemonLaunchArg, hasRemoteSetupLaunchArg } from './runtimeMode';

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

describe('hasRemoteSetupLaunchArg', () => {
  it('detects remote setup when packaged Electron places user args at argv index 1', () => {
    expect(hasRemoteSetupLaunchArg(['Pane.exe', '--remote-setup', '--print-only'])).toBe(true);
  });

  it('accepts the legacy setup alias', () => {
    expect(hasRemoteSetupLaunchArg(['Pane.exe', '--setup-remote'])).toBe(true);
  });
});
