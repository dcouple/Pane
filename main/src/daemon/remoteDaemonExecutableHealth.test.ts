import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectRemoteDaemonExecutableHealth } from './remoteDaemonExecutableHealth';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture(): Promise<{ root: string; paneDir: string; installed: string; proc: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-health-'));
  tempDirs.push(root);
  const paneDir = path.join(root, '.pane_remote');
  const installed = path.join(root, 'pane');
  const proc = path.join(root, 'proc-exe');
  await fs.mkdir(path.join(paneDir, 'remote-daemon'), { recursive: true });
  await fs.writeFile(installed, 'binary', 'utf8');
  await fs.chmod(installed, 0o755);
  await fs.link(installed, proc);
  return { root, paneDir, installed, proc };
}

describe('collectRemoteDaemonExecutableHealth', () => {
  it('reports current process image and a ready resolver independently', async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.paneDir, 'remote-daemon', 'start.sh'), '# pane-remote-daemon-launcher-v2\n', 'utf8');

    const health = collectRemoteDaemonExecutableHealth(fixture.paneDir, {
      platform: 'linux',
      homeDir: fixture.root,
      procExecutablePath: fixture.proc,
      candidates: [fixture.installed],
      readLink: () => fixture.installed,
    });

    expect(health.processImage.status).toBe('current');
    expect(health.restart.status).toBe('ready');
    expect(health.diagnosticCode).toBeUndefined();
  });

  it('does not call a deleted process unsafe when the launcher can restart it', async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.paneDir, 'remote-daemon', 'start.sh'), '# pane-remote-daemon-launcher-v2\n', 'utf8');

    const health = collectRemoteDaemonExecutableHealth(fixture.paneDir, {
      platform: 'linux',
      homeDir: fixture.root,
      candidates: [fixture.installed],
      readLink: () => `${fixture.installed} (deleted)`,
    });

    expect(health.processImage.status).toBe('deleted');
    expect(health.restart.status).toBe('ready');
    expect(health.diagnosticCode).toBe('PANE_REMOTE_DAEMON_UPDATE_PENDING');
  });

  it('reports a replaced process independently from a ready launcher', async () => {
    const fixture = await createFixture();
    const replacedProc = path.join(fixture.root, 'old-pane');
    await fs.writeFile(replacedProc, 'old binary', 'utf8');
    await fs.writeFile(path.join(fixture.paneDir, 'remote-daemon', 'start.sh'), '# pane-remote-daemon-launcher-v2\n', 'utf8');

    const health = collectRemoteDaemonExecutableHealth(fixture.paneDir, {
      platform: 'linux',
      homeDir: fixture.root,
      procExecutablePath: replacedProc,
      candidates: [fixture.installed],
      readLink: () => replacedProc,
    });

    expect(health.processImage.status).toBe('replaced');
    expect(health.restart.status).toBe('ready');
    expect(health.diagnosticCode).toBe('PANE_REMOTE_DAEMON_UPDATE_PENDING');
  });

  it('degrades to unknown identity on platforms without Linux proc evidence', async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.paneDir, 'remote-daemon', 'start.sh'), '# pane-remote-daemon-launcher-v2\n', 'utf8');

    const health = collectRemoteDaemonExecutableHealth(fixture.paneDir, {
      platform: 'darwin',
      homeDir: fixture.root,
      executablePath: fixture.installed,
      candidates: [fixture.installed],
    });

    expect(health.processImage.status).toBe('unknown');
    expect(health.restart.status).toBe('ready');
    expect(health.diagnosticCode).toBeUndefined();
  });

  it('reports the alive-but-doomed combination only when the legacy target is missing', async () => {
    const fixture = await createFixture();
    const missingLegacy = path.join(fixture.root, 'legacy', 'Pane');
    await fs.writeFile(
      path.join(fixture.paneDir, 'remote-daemon', 'start.sh'),
      `#!/bin/sh\nexec '${missingLegacy}' --daemon-headless\n`,
      'utf8',
    );

    const health = collectRemoteDaemonExecutableHealth(fixture.paneDir, {
      platform: 'linux',
      homeDir: fixture.root,
      candidates: [],
      readLink: () => `${missingLegacy} (deleted)`,
    });

    expect(health.processImage.status).toBe('deleted');
    expect(health.restart.status).toBe('broken');
    expect(health.diagnosticCode).toBe('PANE_REMOTE_DAEMON_EXECUTABLE_DELETED');
    expect(health.recoveryCommand).toContain('runpane daemon repair');
  });

  it('keeps a deleted legacy process restart-ready when its compatibility target exists', async () => {
    const fixture = await createFixture();
    await fs.writeFile(
      path.join(fixture.paneDir, 'remote-daemon', 'start.sh'),
      `#!/bin/sh\nexec '${fixture.installed}' --daemon-headless\n`,
      'utf8',
    );

    const health = collectRemoteDaemonExecutableHealth(fixture.paneDir, {
      platform: 'linux',
      homeDir: fixture.root,
      candidates: [fixture.installed],
      readLink: () => `${fixture.installed} (deleted)`,
    });

    expect(health.processImage.status).toBe('deleted');
    expect(health.restart.status).toBe('ready');
    expect(health.diagnosticCode).toBe('PANE_REMOTE_DAEMON_UPDATE_PENDING');
  });
});
