import { useEffect, type CSSProperties } from 'react';

import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import type { Project } from '../types/project';
import { APP_WINDOW_TITLE, formatPaneTitle, resolvePaneStatusPills, resolvePaneTitle } from '../utils/paneTitle';
import { isMac } from '../utils/platformUtils';
import { isWindowControlsOverlayEnabled } from '../utils/titleBarOverlay';
import { Badge } from './ui/Badge';

// SAFETY: Electron supports WebkitAppRegion although React's CSSProperties omits the vendor property.
const TITLE_BAR_STYLE = { height: 38, WebkitAppRegion: 'drag' } as CSSProperties;
// Breathing room between the window controls and the title, on both sides.
const GUTTER_PX = 8;
// Traffic lights sit at x=10 with ~70px of width (see `trafficLightPosition` in
// main/src/index.ts); padding both sides equally keeps the title centered on the
// window while clearing them.
const MAC_INSET_STYLE: CSSProperties = { paddingLeft: 88, paddingRight: 88 };
// Windows and Linux put the controls on the right, and on the left under an RTL
// system layout, so the inset cannot be symmetric or hardcoded. `titlebar-area-x`
// is where the page's share of the strip starts and `titlebar-area-width` how far
// it runs, both in CSS pixels, so the leftover on the far side is everything the
// two do not cover. Chromium recomputes them on DPI, RTL and maximise changes,
// which is why the numbers never appear here.
//
// The `100%` resolves against this element's containing block — the full-width
// `pane-app-shell` column in App.tsx — which is the same coordinate space the
// env() values are reported in.
//
// With the env() fallbacks — the shape a window that somehow lost the overlay
// would compute — this collapses to a symmetric gutter rather than to nothing.
// `max()` keeps a mis-reported rect from producing a negative padding, which CSS
// would drop on the floor.
const OVERLAY_INSET_STYLE: CSSProperties = {
  paddingLeft: `calc(env(titlebar-area-x, 0px) + ${GUTTER_PX}px)`,
  paddingRight: `max(${GUTTER_PX}px, calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%) + ${GUTTER_PX}px))`,
};
// An rtl line box overflows at its left edge, so the ellipsis lands on the head
// and the end of a long pane name ("… (TM-622)") survives. The inner ltr embed
// keeps the name itself a single left-to-right run — without it, trailing
// punctuation is reordered to the clipped end and lost.
const HEAD_ELLIPSIS_STYLE: CSSProperties = { direction: 'rtl' };
const LTR_RUN_STYLE: CSSProperties = { direction: 'ltr', unicodeBidi: 'embed' };

interface WindowTitleBarProps {
  projects: Project[];
}

/**
 * The title bar strip above the tool tabs: a window drag region that also names
 * the pane you are looking at. Passive text only — no pointer handlers, so the
 * whole strip keeps dragging and double-click-to-zoom.
 *
 * It renders wherever the app owns the title bar: macOS via `hiddenInset`, and
 * Windows and Linux via the Window Controls Overlay. A Linux desktop that failed
 * the overlay gate in main keeps its native frame and gets no strip — there it
 * is `document.title`, which this also owns, that carries the pane name. That is
 * true on every platform for the taskbar and task switcher.
 */
export function WindowTitleBar({ projects }: WindowTitleBarProps) {
  const activeView = useNavigationStore(state => state.activeView);
  const activeSession = useSessionStore(state => {
    if (!state.activeSessionId) return undefined;
    if (state.activeMainRepoSession?.id === state.activeSessionId) {
      return state.activeMainRepoSession;
    }
    return state.sessions.find(session => session.id === state.activeSessionId);
  });

  // Project dashboard and Pane Chat are not panes; leave the bar empty there.
  const title = activeView === 'sessions' ? resolvePaneTitle(activeSession, projects) : null;
  const windowTitle = formatPaneTitle(title);

  // Runs before the platform gate below: naming the window is the part of this
  // that a native-framed Windows or Linux window still uses.
  useEffect(() => {
    document.title = windowTitle;
    return () => {
      document.title = APP_WINDOW_TITLE;
    };
  }, [windowTitle]);

  // macOS owns the strip through `hiddenInset`; Windows and Linux own it when
  // main enabled the overlay. Deliberately not gated on
  // `navigator.windowControlsOverlay.visible`: that reads false in plenty of
  // contexts the API is merely present in, and this element carries the window's
  // only drag region once the native title bar is gone. It stays put in
  // fullscreen for the same reason the macOS strip always has.
  if (!isMac() && !isWindowControlsOverlayEnabled()) return null;

  const pills = title ? resolvePaneStatusPills(activeSession) : [];

  return (
    <div
      className="flex-shrink-0 flex items-center justify-center overflow-hidden bg-bg-primary select-none"
      style={{ ...TITLE_BAR_STYLE, ...(isMac() ? MAC_INSET_STYLE : OVERLAY_INSET_STYLE) }}
      data-testid="window-title-bar"
    >
      {title && (
        <div className="relative flex min-w-0 items-center">
          <div
            className="flex min-w-0 items-center gap-1.5 text-xs"
            data-testid="window-title-bar-label"
            title={windowTitle}
          >
            <span className="truncate text-text-tertiary">{title.project}</span>
            {title.pane && (
              <>
                <span className="flex-shrink-0 text-text-tertiary" aria-hidden="true">·</span>
                <span
                  className="truncate font-medium text-text-secondary"
                  style={HEAD_ELLIPSIS_STYLE}
                >
                  <span style={LTR_RUN_STYLE}>{title.pane}</span>
                </span>
              </>
            )}
          </div>
          {pills.length > 0 && (
            // Anchored past the end of the title rather than laid out after it, so a
            // pill appearing or clearing never nudges the centered name sideways.
            <div
              className="absolute left-full top-1/2 flex -translate-y-1/2 items-center gap-1 pl-2"
              data-testid="window-title-bar-pills"
            >
              {pills.map(pill => (
                <Badge
                  key={pill.key}
                  variant={pill.variant}
                  size="sm"
                  className="whitespace-nowrap px-1.5 py-0 text-[10px] leading-4"
                  title={pill.tooltip}
                >
                  {pill.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
