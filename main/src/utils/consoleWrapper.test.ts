import { afterEach, describe, expect, it, vi } from 'vitest';

const savedConsole = { ...console };

function throwingConsoleMethod(error: Error): typeof console.log {
  return vi.fn(() => {
    throw error;
  });
}

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
      log: throwingConsoleMethod(epipe),
      error: throwingConsoleMethod(epipe),
    });

    setupConsoleWrapper();

    expect(() => console.log('[Main] startup log')).not.toThrow();
    expect(() => console.error('[Pane daemon] Failed to start local daemon server')).not.toThrow();
  });

  it('preserves unexpected console write failures', async () => {
    const { setupConsoleWrapper } = await loadConsoleWrapperWithOriginals({
      log: throwingConsoleMethod(new Error('unexpected console failure')),
    });

    setupConsoleWrapper();

    expect(() => console.log('[Main] startup log')).toThrow('unexpected console failure');
  });
});
