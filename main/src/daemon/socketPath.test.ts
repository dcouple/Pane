import { describe, expect, it } from 'vitest';
import { getPaneDaemonEndpoint, getPaneDaemonSocketDirectory } from './socketPath';

describe('Pane daemon socket path', () => {
  it('uses a short hashed temp directory and stable socket file on Unix-like platforms', () => {
    const endpoint = getPaneDaemonEndpoint('/Users/parsa/.pane', 'darwin');
    const socketDirectory = getPaneDaemonSocketDirectory('/Users/parsa/.pane', 'darwin');

    expect(endpoint.transport).toBe('unix');
    expect(endpoint.path).toBe(`${socketDirectory}/daemon.sock`);
    expect(socketDirectory).toMatch(/^\/tmp\/pane-daemon(?:-\d+)?-[0-9a-f]{16}$/);
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
    expect(endpoint.path.startsWith('/tmp/pane-daemon')).toBe(true);
    expect(endpoint.path.endsWith('/daemon.sock')).toBe(true);
  });

  it('keeps Unix socket paths short even for deeply nested app directories', () => {
    const deepPath = `/Users/parsa/${'very-nested-directory/'.repeat(20)}.pane`;
    const endpoint = getPaneDaemonEndpoint(deepPath, 'linux');

    expect(endpoint.transport).toBe('unix');
    expect(Buffer.byteLength(endpoint.path)).toBeLessThan(100);
  });
});
