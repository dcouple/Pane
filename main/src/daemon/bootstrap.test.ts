import { describe, expect, it, vi } from 'vitest';
import { syncRemoteTransportForMode } from './remoteTransportStartup';

describe('syncRemoteTransportForMode', () => {
  it('cleans up and rejects a headless transport startup failure', async () => {
    const error = new Error('EADDRINUSE');
    const cleanup = vi.fn(async () => {});
    await expect(syncRemoteTransportForMode({
      syncToConfig: vi.fn(async () => { throw error; }),
    }, 'headless', cleanup)).rejects.toBe(error);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps desktop startup nonfatal when remote transport fails', async () => {
    const cleanup = vi.fn(async () => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(syncRemoteTransportForMode({
      syncToConfig: vi.fn(async () => { throw new Error('EADDRINUSE'); }),
    }, 'desktop', cleanup)).resolves.toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
