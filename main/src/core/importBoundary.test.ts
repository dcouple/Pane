import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const MAIN_SRC_ROOT = path.resolve(process.cwd(), 'src');

function readMainSrcFile(relativePath: string): string {
  return fs.readFileSync(path.join(MAIN_SRC_ROOT, relativePath), 'utf8');
}

describe('daemon/client import boundary', () => {
  it('keeps targeted services off bootstrap globals', () => {
    const serviceFiles = [
      'events.ts',
      'services/panelManager.ts',
      'services/terminalPanelManager.ts',
      'services/terminalSessionManager.ts',
      'services/runCommandManager.ts',
      'services/sessionManager.ts',
      'services/scriptExecutionTracker.ts',
      'services/taskQueue.ts',
      'services/panels/cli/AbstractCliManager.ts',
      'services/panels/logPanel/logsManager.ts',
    ];

    for (const relativePath of serviceFiles) {
      const source = readMainSrcFile(relativePath);
      expect(source, relativePath).not.toMatch(/from ['"](?:\.\.\/)+(?:index)['"]/);
      expect(source, relativePath).not.toMatch(/from ['"](?:\.\.\/)+(?:index)\.ts['"]/);
    }
  });

  it('routes targeted renderer sends through the event sink adapter', () => {
    const eventFiles = [
      'events.ts',
      'services/panelManager.ts',
      'services/terminalPanelManager.ts',
      'services/panels/logPanel/logsManager.ts',
    ];

    for (const relativePath of eventFiles) {
      const source = readMainSrcFile(relativePath);
      expect(source, relativePath).not.toContain('webContents.send(');
      expect(source, relativePath).not.toContain('mainWindow');
    }
  });

  it('keeps the daemon server free of Electron bootstrap imports', () => {
    const daemonBoundaryFiles = [
      'daemon/server.ts',
      'ipc/daemon.ts',
    ];

    for (const relativePath of daemonBoundaryFiles) {
      const source = readMainSrcFile(relativePath);

      expect(source, relativePath).not.toContain("from 'electron'");
      expect(source, relativePath).not.toContain('mainWindow');
      expect(source, relativePath).not.toMatch(/from ['"](?:\.\.\/)+(?:index)['"]/);
      expect(source, relativePath).not.toMatch(/from ['"](?:\.\.\/)+(?:index)\.ts['"]/);
    }
  });

  it('routes daemon-owned preload invokes through the runtime-safe bridge helper', () => {
    const source = readMainSrcFile('preload.ts');

    expect(source).toContain('function isDaemonOwnedChannel');
    expect(source).toContain('isDaemonOwnedChannel');
    expect(source).not.toContain("../../shared/types/daemon");
    expect(source).not.toContain("from './daemon/daemonChannels'");
    expect(source).toContain("ipcRenderer.invoke('daemon:invoke', channel, ...args)");
    expect(source).not.toMatch(
      /ipcRenderer\.invoke\('(sessions:|projects:|folders:|prompts:|resource-monitor:|panels:|terminal:|logs:|git:(cancel-status-for-project|clone-repo|commit|execute-project|file-status|get-github-remote|restore|revert)|file:(copy|delete|duplicate|exists|getPath|list|move|read|read-binary|read-project|readAtRevision|rename|resolveAbsolutePath|search|write|write-binary|write-project))/,
    );
  });
});
