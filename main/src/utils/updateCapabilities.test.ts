import { describe, expect, it, vi } from 'vitest';
import {
  getMacAppBundlePath,
  getUpdateCapabilities,
  verifyDcoupleMacSignature,
} from './updateCapabilities';

describe('update capabilities', () => {
  it('preserves seamless updates on non-macOS platforms', async () => {
    await expect(getUpdateCapabilities({
      platform: 'win32',
      isPackaged: true,
      executablePath: 'C:\\Pane\\Pane.exe',
    })).resolves.toEqual({ mode: 'seamless', reason: 'platform-supported' });
  });

  it('keeps development and unsigned macOS builds on the manual path', async () => {
    await expect(getUpdateCapabilities({
      platform: 'darwin',
      isPackaged: false,
      executablePath: '/Applications/Pane.app/Contents/MacOS/Pane',
    })).resolves.toEqual({ mode: 'manual', reason: 'development-build' });

    await expect(getUpdateCapabilities({
      platform: 'darwin',
      isPackaged: true,
      executablePath: '/Applications/Pane.app/Contents/MacOS/Pane',
      verifySignature: async () => false,
    })).resolves.toEqual({ mode: 'manual', reason: 'untrusted-signature' });
  });

  it('enables seamless updates for a trusted packaged macOS build', async () => {
    const verifySignature = vi.fn(async () => true);
    await expect(getUpdateCapabilities({
      platform: 'darwin',
      isPackaged: true,
      executablePath: '/Applications/Pane.app/Contents/MacOS/Pane',
      verifySignature,
    })).resolves.toEqual({ mode: 'seamless', reason: 'trusted-dcouple-signature' });
    expect(verifySignature).toHaveBeenCalledWith('/Applications/Pane.app');
  });

  it('falls back safely when signature verification fails', async () => {
    await expect(getUpdateCapabilities({
      platform: 'darwin',
      isPackaged: true,
      executablePath: '/Applications/Pane.app/Contents/MacOS/Pane',
      verifySignature: async () => { throw new Error('codesign unavailable'); },
    })).resolves.toEqual({ mode: 'manual', reason: 'untrusted-signature' });
  });

  it('requires both the Dcouple authority and team identifier', async () => {
    const command = vi.fn(async (_file: string, args: string[]) => ({
      stderr: args.includes('-dv')
        ? 'Authority=Developer ID Application: Dcouple Inc (FBM5YSF467)\nTeamIdentifier=FBM5YSF467\n'
        : '',
    }));
    await expect(verifyDcoupleMacSignature('/Applications/Pane.app', command)).resolves.toBe(true);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('rejects executable paths outside an app bundle', () => {
    expect(getMacAppBundlePath('/usr/local/bin/pane')).toBeNull();
  });
});
