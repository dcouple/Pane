import {
  boundary,
  decodeOptionalBoundary,
  type BoundarySchema,
} from '../../../shared/validation/boundaryDecoder';

/**
 * Window Controls Overlay (WCO) support for Windows and Linux.
 *
 * With `titleBarStyle: 'hidden'` + `titleBarOverlay`, the OS keeps drawing the
 * minimise/maximise/close buttons in the corner — so Windows keeps Snap Layouts
 * on maximise hover — and the rest of the title bar becomes page content. That
 * is the direct analogue of macOS `hiddenInset`, which is why `WindowTitleBar`
 * can render the same strip on all three platforms.
 *
 * The buttons stay OS-drawn, so their plate does not inherit our CSS. It has to
 * be told the theme's colours via `titleBarOverlay.color` / `symbolColor` at
 * window creation and re-told on every theme switch through
 * `win.setTitleBarOverlay()`.
 */

/**
 * Overlay height in DIPs. Matches `TITLE_BAR_STYLE.height` in
 * `frontend/src/components/WindowTitleBar.tsx` so the strip is the same size on
 * every platform; the system default is ~32px on Windows.
 */
export const WINDOW_CONTROLS_OVERLAY_HEIGHT = 38;

/** Preference key holding the last colours the renderer derived from the theme. */
export const WINDOW_CONTROLS_OVERLAY_COLORS_KEY = 'windowControlsOverlayColors';

/**
 * Passed to the renderer through `webPreferences.additionalArguments` so the
 * preload can answer "is the overlay on?" synchronously, before first paint.
 * The renderer must not re-derive the gate below: if it disagreed with the main
 * process on Linux we would ship either a frameless window with no drag region
 * or a doubled title bar.
 */
export const WINDOW_CONTROLS_OVERLAY_ARG = '--pane-window-controls-overlay';

/** Explicit user override, checked before any platform detection. */
const OVERRIDE_ENV_VAR = 'PANE_WINDOW_CONTROLS_OVERLAY';

/**
 * Desktop environments that draw client-side decorations, so a window without a
 * server-side title bar still gets resize borders, shadows and snapping.
 * Anything not on this list — bare window managers, tiling WMs, kiosk and
 * remote sessions, or an unset `XDG_CURRENT_DESKTOP` — keeps the native frame.
 */
const CSD_DESKTOPS = new Set([
  'gnome',
  'gnome-classic',
  'gnome-flashback',
  'ubuntu',
  'unity',
  'kde',
  'plasma',
  'cinnamon',
  'x-cinnamon',
  'xfce',
  'mate',
  'pantheon',
  'budgie',
  'budgie-desktop',
  'deepin',
  'dde',
  'lxqt',
  'cosmic',
]);

/**
 * `XDG_CURRENT_DESKTOP` is a colon-separated preference list ("ubuntu:GNOME"),
 * so any token matching is enough. The two session variables are checked as
 * fallbacks because some display managers only set one of the three.
 */
function detectsCsdDesktop(env: NodeJS.ProcessEnv): boolean {
  const sources = [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION];

  return sources.some((source) =>
    (source ?? '')
      .split(':')
      .map((token) => token.trim().toLowerCase())
      .some((token) => token.length > 0 && CSD_DESKTOPS.has(token))
  );
}

/**
 * Whether this process should hand the title bar to the page.
 *
 * macOS is excluded because it already has `hiddenInset`. Windows is always on.
 * Linux is opt-out by desktop environment rather than opt-in by guesswork: WCO
 * behaviour there is a property of the window manager, and the fallback (native
 * frame plus `document.title`) is the behaviour that shipped in #475, so an
 * unrecognised desktop loses nothing.
 */
export function shouldEnableWindowControlsOverlay(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): boolean {
  // Not an override the escape hatch below can reach: `hiddenInset` and the
  // overlay are mutually exclusive, and macOS has no overlay to colour.
  if (platform !== 'win32' && platform !== 'linux') return false;

  const override = env[OVERRIDE_ENV_VAR];
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;

  return platform === 'win32' || detectsCsdDesktop(env);
}

export interface WindowControlsOverlayColors {
  /** Plate behind the OS-drawn buttons. */
  color: string;
  /** The glyphs on those buttons. */
  symbolColor: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Electron hands these straight to Chromium's CSS colour parser, which accepts a
 * narrower grammar than CSS itself (no space-separated `rgb()`, no `oklch()`).
 * The renderer already normalises to `#rrggbb`; anything else is refused here
 * rather than passed on to native code.
 */
const overlayHexColor: BoundarySchema<string> = {
  decode(current) {
    const value = boundary.string.decode(current).trim();
    return HEX_COLOR.test(value) ? value.toLowerCase() : current.fail('expected #rrggbb color');
  },
};

/** Decodes the overlay colour pair from an untrusted IPC or preference payload. */
export const overlayColorsSchema = boundary.object({
  color: overlayHexColor,
  symbolColor: overlayHexColor,
});

/** Parses the persisted preference written by the theme bridge. */
export function parseStoredOverlayColors(raw: string | null): WindowControlsOverlayColors | null {
  if (!raw) return null;
  try {
    return decodeOptionalBoundary(JSON.parse(raw), overlayColorsSchema) ?? null;
  } catch {
    return null;
  }
}
