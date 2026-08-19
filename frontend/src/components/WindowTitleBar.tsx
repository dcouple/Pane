import { useEffect, type CSSProperties } from 'react';

import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import type { Project } from '../types/project';
import { APP_WINDOW_TITLE, formatPaneTitle, resolvePaneStatusPills, resolvePaneTitle } from '../utils/paneTitle';
import { isMac } from '../utils/platformUtils';
import { Badge } from './ui/Badge';

// SAFETY: Electron supports WebkitAppRegion although React's CSSProperties omits the vendor property.
const TITLE_BAR_STYLE = { height: 38, WebkitAppRegion: 'drag' } as CSSProperties;
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
 * The macOS title bar strip above the tool tabs: a window drag region that also
 * names the pane you are looking at. Passive text only — no pointer handlers, so
 * the whole strip keeps dragging and double-click-to-zoom.
 *
 * Windows and Linux keep their native frame, so there is no strip to fill there —
 * but they still get the name, because this also owns `document.title`. That is
 * what their native title bar reads, and what every platform's task switcher and
 * taskbar show, so the window is identifiable off-screen as well as on it.
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
  // that Windows and Linux can use.
  useEffect(() => {
    document.title = windowTitle;
    return () => {
      document.title = APP_WINDOW_TITLE;
    };
  }, [windowTitle]);

  if (!isMac()) return null;

  const pills = title ? resolvePaneStatusPills(activeSession) : [];

  return (
    <div
      // Traffic lights sit at x=10 with ~70px of width (see `trafficLightPosition`
      // in main/src/index.ts); padding both sides equally keeps the title centered
      // on the window while clearing them.
      className="flex-shrink-0 flex items-center justify-center overflow-hidden bg-bg-primary px-[88px] select-none"
      style={TITLE_BAR_STYLE}
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
