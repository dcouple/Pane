/**
 * Gate for the Software Update dialog's quit affordance.
 *
 * Extracted so it can be unit tested without a DOM: Modal renders through a
 * Radix portal, so renderToStaticMarkup produces nothing for the dialog body.
 */

export interface ManualQuitGate {
  isPackaged: boolean;
  isMacPlatform: boolean;
  hasUpdate: boolean;
}

/**
 * Whether to offer quitting Pane from the update dialog.
 *
 * Only the macOS manual-install path needs it. There the DMG mounts while Pane
 * is still running, so the drag into /Applications fails until Pane exits.
 * Windows replaces the app in place through quitAndInstall(), and an unpackaged
 * dev build has no installer to make room for.
 */
export function shouldOfferQuitForManualInstall(gate: ManualQuitGate): boolean {
  return gate.isPackaged && gate.isMacPlatform && gate.hasUpdate;
}
