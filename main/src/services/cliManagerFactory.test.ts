import { describe, expect, it } from 'vitest';
import { decodePermissionIpcPath } from './cliManagerFactory';

describe('decodePermissionIpcPath', () => {
  it('preserves the degraded startup path for missing and null endpoints', () => {
    expect(decodePermissionIpcPath()).toBeNull();
    expect(decodePermissionIpcPath({ permissionIpcPath: null })).toBeNull();
  });

  it('accepts a valid IPC endpoint', () => {
    expect(decodePermissionIpcPath({ permissionIpcPath: '\\\\.\\pipe\\pane-permissions-42' }))
      .toBe('\\\\.\\pipe\\pane-permissions-42');
  });

  it('rejects a non-string, non-null endpoint', () => {
    expect(() => decodePermissionIpcPath({ permissionIpcPath: 42 })).toThrow('expected string');
  });
});
