import { describe, expect, it } from 'vitest';
import { shouldOfferQuitForManualInstall, type ManualQuitGate } from './updateDialogQuit';

const macWithUpdate: ManualQuitGate = {
  isPackaged: true,
  isMacPlatform: true,
  hasUpdate: true,
};

describe('shouldOfferQuitForManualInstall', () => {
  it('offers the quit affordance on the packaged macOS manual-install path', () => {
    expect(shouldOfferQuitForManualInstall(macWithUpdate)).toBe(true);
  });

  it('stays off where the installer replaces Pane in place', () => {
    // Windows auto-updates through quitAndInstall(), so nothing needs the user
    // to free the bundle by hand.
    expect(shouldOfferQuitForManualInstall({ ...macWithUpdate, isMacPlatform: false })).toBe(false);
  });

  it('stays off in an unpackaged build, which has no bundle to replace', () => {
    expect(shouldOfferQuitForManualInstall({ ...macWithUpdate, isPackaged: false })).toBe(false);
  });

  it('stays off when there is no update to install', () => {
    expect(shouldOfferQuitForManualInstall({ ...macWithUpdate, hasUpdate: false })).toBe(false);
  });
});
