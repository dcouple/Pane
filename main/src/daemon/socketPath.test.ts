import { describe, expect, it } from 'vitest';
import { getPaneDaemonEndpoint, getPaneDaemonSocketDirectory } from './socketPath';

describe('Pane daemon socket path', () => {
  it('uses a sockets subdirectory and stable socket file on Unix-like platforms', () => {
    const endpoint = getPaneDaemonEndpoint('/Users/parsa/.pane', 'darwin');

    expect(endpoint).toEqual({
      transport: 'unix',
      path: '/Users/parsa/.pane/sockets/daemon.sock',
    });
    expect(getPaneDaemonSocketDirectory('/Users/parsa/.pane', 'darwin')).toBe('/Users/parsa/.pane/sockets');
  });

  it('uses a stable named pipe on Windows', () => {
    const endpoint = getPaneDaemonEndpoint('C:\\Users\\Parsa\\.pane', 'win32');

    expect(endpoint.transport).toBe('pipe');
    expect(endpoint.path).toMatch(/^\\\\\.\\pipe\\pane-daemon-[0-9a-f]{16}$/);
    expect(getPaneDaemonSocketDirectory('C:\\Users\\Parsa\\.pane', 'win32')).toBeNull();
  });

  it('normalizes Windows path case before hashing the pipe name', () => {
    const upper = getPaneDaemonEndpoint('C:\\Users\\Parsa\\.pane', 'win32');
    const lower = getPaneDaemonEndpoint('c:\\users\\parsa\\.pane', 'win32');

    expect(upper).toEqual(lower);
  });

  it('resolves relative Unix paths before building the endpoint', () => {
    const endpoint = getPaneDaemonEndpoint('.pane-test', 'linux');

    expect(endpoint.transport).toBe('unix');
    expect(endpoint.path.endsWith('/sockets/daemon.sock')).toBe(true);
  });
});
