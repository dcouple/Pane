import { afterEach, describe, expect, it, vi } from 'vitest';

const savedConsole = { ...console };

async function loadConsoleWrapperWithOriginals(originals: Partial<Console>) {
  vi.resetModules();
  Object.assign(console, originals);
  return import('./consoleWrapper');
}

afterEach(() => {
  Object.assign(console, savedConsole);
  vi.resetModules();
});

describe('setupConsoleWrapper', () => {
  it('ignores EPIPE from closed stdout or stderr streams', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const { setupConsoleWrapper } = await loadConsoleWrapperWithOriginals({
      log: vi.fn(() => {
        throw epipe;
      }) as unknown as typeof console.log,
      error: vi.fn(() => {
        throw epipe;
      }) as unknown as typeof console.error,
    });

    setupConsoleWrapper();

    expect(() => console.log('[Main] startup log')).not.toThrow();
    expect(() => console.error('[Pane daemon] Failed to start local daemon server')).not.toThrow();
  });

  it('preserves unexpected console write failures', async () => {
    const { setupConsoleWrapper } = await loadConsoleWrapperWithOriginals({
      log: vi.fn(() => {
        throw new Error('unexpected console failure');
      }) as unknown as typeof console.log,
    });

    setupConsoleWrapper();

    expect(() => console.log('[Main] startup log')).toThrow('unexpected console failure');
  });
});
