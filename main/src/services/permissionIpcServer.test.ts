import { afterEach, describe, expect, it } from 'vitest';
import { getPermissionIpcEndpoint, PermissionIpcServer } from './permissionIpcServer';

describe('PermissionIpcServer', () => {
  let server: PermissionIpcServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('uses a Windows named pipe instead of a filesystem socket path', () => {
    expect(getPermissionIpcEndpoint('win32', 42, 'C:\\Users\\test\\.pane\\sockets'))
      .toBe('\\\\.\\pipe\\pane-permissions-42');
  });

  it('uses a socket file on Unix platforms', () => {
    expect(getPermissionIpcEndpoint('linux', 42, '/tmp/pane-sockets'))
      .toBe('/tmp/pane-sockets/pane-permissions-42.sock');
  });

  it('starts and stops the platform endpoint', async () => {
    server = new PermissionIpcServer();

    await server.start();

    if (process.platform === 'win32') {
      expect(server.getSocketPath()).toMatch(/^\\\\\.\\pipe\\pane-permissions-\d+$/);
    } else {
      expect(server.getSocketPath()).toMatch(/pane-permissions-\d+\.sock$/);
    }
  });
});
