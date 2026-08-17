import { execFileSync } from 'child_process';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readWebAttribution, resolveAnalyticsIdentity } from './analyticsIdentity';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../utils/shellPath', () => ({
  getShellPath: () => '/usr/bin',
}));

const execFileSyncMock = vi.mocked(execFileSync);

function mockCommandOutput(outputs: Record<string, string>): void {
  // SAFETY: The mock implements only the string-returning execFileSync overload used by analyticsIdentity.
  execFileSyncMock.mockImplementation(((command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`;
    if (key in outputs) {
      return outputs[key];
    }
    throw new Error(`Unexpected command: ${key}`);
  }) as never);
}

describe('resolveAnalyticsIdentity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses the stable install ID when no git or GitHub identity is available', () => {
    mockCommandOutput({});

    expect(resolveAnalyticsIdentity(undefined, 'install_123')).toEqual({
      distinctId: 'install:install_123',
      identitySource: 'anonymous',
      installId: 'install_123',
      githubUsername: undefined,
      githubEmail: undefined,
      gitEmail: undefined,
      gitEmailHash: undefined,
      gitUserName: undefined,
    });
  });

  it('keeps an existing PostHog ID until a stronger identity is available', () => {
    mockCommandOutput({});

    expect(resolveAnalyticsIdentity('existing_distinct', 'install_123')).toMatchObject({
      distinctId: 'existing_distinct',
      identitySource: 'posthog',
      installId: 'install_123',
    });
  });

  it('keeps the install-ID fallback classified as anonymous on later launches', () => {
    mockCommandOutput({});

    expect(resolveAnalyticsIdentity('install:install_123', 'install_123')).toMatchObject({
      distinctId: 'install:install_123',
      identitySource: 'anonymous',
      installId: 'install_123',
    });
  });

  it('prefers email identity and hashes the normalized email', () => {
    mockCommandOutput({
      'gh api user --jq .login': 'octocat\n',
      'git config --global user.email': 'Dev@Example.COM\n',
      'git config --global user.name': 'Dev User\n',
    });

    const identity = resolveAnalyticsIdentity(undefined, 'install_123');

    expect(identity).toMatchObject({
      distinctId: 'email:dev@example.com',
      identitySource: 'email',
      installId: 'install_123',
      githubUsername: 'octocat',
      gitEmail: 'Dev@Example.COM',
      gitUserName: 'Dev User',
    });
    expect(identity.gitEmailHash).toBe('eb2b6c0d061bbd5caa545b6d1184a1887b11dba0b1d7fd8ca5b42ebf0ad7d3a8');
  });
});

describe('readWebAttribution', () => {
  it('reads a valid web distinct ID token', () => {
    const appDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pane-attribution-'));
    const token = Buffer.from('web_distinct|1710000000000').toString('base64url');

    try {
      fsSync.writeFileSync(path.join(appDir, 'attribution_ref'), token);

      expect(readWebAttribution(appDir)).toBe('web_distinct');
    } finally {
      fsSync.rmSync(appDir, { recursive: true, force: true });
    }
  });
});
