import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { WebLinksAddon } from '@xterm/addon-web-links';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { Unicode11Addon } from '@xterm/addon-unicode11';
import { useSession } from '../../contexts/SessionContext';
import { useTheme } from '../../contexts/ThemeContext';
import { TerminalPanelProps } from '../../types/panelComponents';
import { useHotkeyStore } from '../../stores/hotkeyStore';
import { renderLog, devLog } from '../../utils/console';
import { getTerminalTheme } from '../../utils/terminalTheme';
import { resolveTerminalKeyHandling } from '../../utils/terminalKeyHandling';
import { isMac } from '../../utils/platformUtils';
import { FileEdit, FolderOpen } from 'lucide-react';
import { useTerminalLinks } from '../terminal/hooks/useTerminalLinks';
import { TerminalLinkTooltip } from '../terminal/TerminalLinkTooltip';
import { TerminalPopover, PopoverButton } from '../terminal/TerminalPopover';
import { SelectionPopover } from '../terminal/SelectionPopover';
import { useTerminalSearch } from '../../hooks/useTerminalSearch';
import { TerminalSearchOverlay } from '../terminal/TerminalSearchOverlay';
import type { TerminalPanelState } from '../../../../shared/types/panels';
import { selectTerminalRestoreContent } from '../../utils/terminalRestore';
import { TerminalInterceptor } from '../../services/terminalInterceptor/TerminalInterceptor';
import { createAtTerminalHandler } from '../../services/terminalInterceptor/handlers/atTerminalHandler';
import { InterceptorDropdown } from '../terminal/InterceptorDropdown';
import { InterceptorToast } from '../terminal/InterceptorToast';
import { usePanelStore } from '../../stores/panelStore';
import { useConfigStore } from '../../stores/configStore';
import type { InterceptorState, AtTerminalHandlerState, TerminalSuggestion } from '../../services/terminalInterceptor/types';
import '@xterm/xterm/css/xterm.css';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const TerminalSpinner: React.FC = () => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="text-accent-primary text-2xl font-mono">{SPINNER_FRAMES[frame]}</span>
  );
};

// Type for terminal state restoration
interface TerminalRestoreState {
  scrollbackBuffer: string | string[];
  alternateScreenBuffer?: string;
  isAlternateScreen?: boolean;
  serializedBuffer?: string;
  cursorX?: number;
  cursorY?: number;
}

const DEFAULT_TERMINAL_FONT_FAMILY = 'Geist Mono';
const DEFAULT_TERMINAL_FONT_SIZE = 14;
const WEBGL_APP_BLUR_DETACH_DELAY_MS = 10_000;
const REFOCUS_DELAYED_REFRESH_MS = 300;
const TERMINAL_ACTIVATION_MASK_AFTER_PAINT_MS = 200;
const FORCED_REDRAW_TRANSITION_MS = 50;
const TERMINAL_VISIBILITY_REFRESH_MS = 60_000;
const SNAPSHOT_MIN_INTERVAL_MS = 10_000;
const MIN_VIABLE_RECT_PX = 100; // below this the container is hidden or mid-layout (Allotment minSize is 120)
const MIN_PTY_COLS = 20;        // mirrors main-process floor
const MIN_PTY_ROWS = 5;
const NEAR_BOTTOM_THRESHOLD_ROWS = 3;
const TERMINAL_VISIBILITY_VIEWER_ID = getTerminalVisibilityViewerId();

function getTerminalVisibilityViewerId(): string {
  const storageKey = 'pane-terminal-visibility-viewer-id';
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;

    const next = globalThis.crypto?.randomUUID?.()
      ?? `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(storageKey, next);
    return next;
  } catch {
    return `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function buildTerminalFontFamily(userFont: string): string {
  return `"${userFont}", "Symbols Nerd Font Mono", monospace`;
}

function isClipboardImagePlaceholderText(text: string): boolean {
  return text.trim() === '[Image]';
}

function waitForNextPaint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Terminal panel lifecycle — the invariants below keep hidden terminals cheap
 * and correct; break one and you get mangled buffers or replay storms.
 *
 * MOUNT (possibly hidden): keep-alive terminal tabs mount even when inactive
 * (PanelGroupView renders them behind display:none). The PTY spawns at the
 * backend default (80×30) when the container has no measurable size, and the
 * mount-time fit() is SKIPPED for containers below MIN_VIABLE_RECT_PX —
 * FitAddon has no cols floor, so fitting a 0×0 container would shrink the
 * grid to a few columns and background PTY output would parse into a
 * garbage-width buffer that xterm reflow cannot repair. A skipped mount fit
 * arms `needsFullActivationRefreshRef` so the first activation rebuilds the
 * buffer at the settled width. The same width guard applies to every other
 * grid-resizing path (resizePtyToFit, post-restore fit, font-change fit).
 *
 * HIDDEN (performance mode): the panel keeps reporting visible to main
 * (`effectiveVisible` is hard-coded true), so PTY output keeps streaming and
 * the xterm buffer stays live while display:none. Battery saver instead
 * reports hidden — main stops renderer delivery — so its buffer genuinely
 * goes stale while inactive.
 *
 * ACTIVATION (tab shown and window focused — `activationVisible`): initial
 * construction, remounts/session switches, battery saver, sustained-blur
 * recovery, and manual Refresh run the full masked reset+replay from
 * `terminal:getState` (`handleRefreshTerminal`). A narrowly eligible same-
 * session hot activation may instead preserve the continuously updated mounted
 * xterm and perform masked fit/reconcile/refresh. This is intentionally gated:
 * two shipped attempts to broadly lighten activation — a fit+repaint activation
 * (v2.4.11) and keep-alive WebGL contexts with an atlas clear (v2.4.14) —
 * produced ghosted rows and garbage-glyph atlas corruption (xterm terminals
 * with the same font/theme SHARE a texture atlas; clearing it from one terminal
 * poisons the others). A short performance-mode window refocus where WebGL
 * stayed attached takes the light silent `repaintTerminal` path. A sustained
 * blur invalidates hot eligibility and arms full recovery. A delayed backstop
 * re-runs the chosen depth once (REFOCUS_DELAYED_REFRESH_MS).
 *
 * WEBGL: one context per VISIBLE terminal. Detached immediately on panel
 * hide, kept through short app blurs, detached after a sustained blur
 * (WEBGL_APP_BLUR_DETACH_DELAY_MS) and arm a full refresh for the next
 * focused activation. Re-attach paints via a refresh deferred past the next
 * frame — same-task refreshes can hit an uncomposited canvas. While detached,
 * xterm falls back to the DOM renderer. Never call `clearTextureAtlas()`
 * here: the atlas is shared across terminals.
 *
 * PERSISTENCE: main owns the raw scrollback (authoritative, ANSI-safe
 * trimmed); the renderer serializes a formatting-preserving snapshot on
 * hide (throttled to SNAPSHOT_MIN_INTERVAL_MS) and on unmount, used only for
 * app-restart restore. Live restores always prefer main's raw scrollback.
 *
 * UNMOUNT (session switch / panel close): serialize a final snapshot, then
 * dispose WebGL, addons, and the xterm instance. Remounts restore from
 * `terminal:getState` (capped payload) and replay once into a fresh xterm.
 * This differs intentionally from terminal clients that retain every renderer
 * and its DOM node for every session: Pane bounds renderer memory, listeners,
 * WebGL resources, and duplicate output parsing to the mounted top-level Pane
 * session. Tool tabs inside that session are still kept mounted as described
 * above. The main-process PTY and headless emulator remain authoritative, so
 * background agents keep running and local-control screen reads remain correct
 * without a renderer per session. The tradeoff is that remounting exposes
 * foreground-TUI redraw assumptions hidden by retained-DOM designs. Restoring
 * cells recreates terminal state but cannot make the application recompute its
 * layout, which is why activation finishes with a timed real PTY size
 * transition and return.
 */
export const TerminalPanel: React.FC<TerminalPanelProps> = React.memo(({ panel, isActive, autoFocus = true }) => {
  renderLog('[TerminalPanel] Component rendering, panel:', panel.id, 'isActive:', isActive);
  
  // All hooks must be called at the top level, before any conditional returns
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webLinksAddonRef = useRef<WebLinksAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const unicode11AddonRef = useRef<Unicode11Addon | null>(null);
  const isActiveRef = useRef(isActive);
  const isNearBottomRef = useRef(true); // Track if user is scrolled near the bottom
  const [showScrollDown, setShowScrollDown] = useState(false); // Show jump-to-bottom pill
  const tuiActiveRef = useRef(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [interceptorState, setInterceptorState] = useState<InterceptorState | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [windowFocused, setWindowFocused] = useState(true);
  const interceptorRef = useRef<TerminalInterceptor | null>(null);
  const skipNextInterceptRef = useRef(false); // set by AltGr @ detection
  const terminalPowerMode = useConfigStore((state) => state.config?.terminalPowerMode ?? 'performance');
  const useBatterySaverTerminalVisibility = terminalPowerMode === 'batterySaver';
  const panelVisible = isActive;
  const effectiveVisible = useBatterySaverTerminalVisibility ? panelVisible && windowFocused : true;
  // Drives the shared activation refresh: fires on tab activation and window
  // refocus in both power modes (effectiveVisible is hard-coded true in
  // performance mode, so it cannot serve this role).
  const activationVisible = panelVisible && windowFocused;
  // True when the next activation needs the full reset+replay path: the panel
  // was hidden, a sustained app blur detached WebGL (either renderer swap can
  // leave stale frames/atlas state that no light repaint can clear — see the
  // WEBGL lifecycle note), or battery saver gated PTY output while inactive.
  // This full refresh on activation is LOAD-BEARING for paint correctness: two
  // attempts to replace it with a light repaint (v2.4.11) and with keep-alive
  // WebGL contexts (v2.4.14) shipped ghosted rows and texture-atlas corruption.
  // Do not remove it again without an offline repro of the renderer-swap
  // artifacts. A short performance-mode refocus leaves both the buffer and
  // renderer live, so a light repaint is enough there.
  const needsFullActivationRefreshRef = useRef(true);
  // Fast activation is only safe after this exact mounted xterm has completed a
  // full refresh and has remained on the ungated performance-mode output path.
  // A fresh mount starts false so it cannot skip its initial reset/replay.
  const hotActivationEligibleRef = useRef(false);
  const hotActivationPendingRef = useRef(false);
  const [webglAllowed, setWebglAllowed] = useState(panelVisible);
  const blurDetachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read CLI state from persisted panel state (handles remount case)
  const terminalState = panel.state?.customState as TerminalPanelState | undefined;
  const isCliPanel = !!terminalState?.isCliPanel;
  const [isCliReady, setIsCliReady] = useState(!!terminalState?.isCliReady);
  const isRemoteMode = useConfigStore((state) => state.config?.remoteDaemon?.client.mode === 'remote');
  const isCliPanelRef = useRef(isCliPanel);

  // ptyId for the current PTY behind this panel, delivered via
  // `terminal:ptyReady` when spawned through the ptyHost UtilityProcess.
  // Null under the legacy `pty.spawn` path. Re-fires with a new value on
  // auto-reattach after a supervisor restart, which re-subscribes the data
  // listener below.
  const [ptyId, setPtyId] = useState<string | null>(null);

  // Ref holding the terminal output consumer installed by the main init effect.
  // The data-subscription effect below reads from this ref so it can swap the
  // subscription source (legacy `terminal:output` vs `electronAPI.ptyHost.onData`)
  // without re-running the full terminal init.
  const outputConsumerRef = useRef<{
    write: (data: string) => void;
  } | null>(null);

  // Mirror of `ptyId` so the ack-flush closure (captured inside the init effect)
  // can read the current value without re-creating. Updated by the effect below
  // whenever `ptyId` changes (spawn, auto-reattach, or unmount).
  const currentPtyIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentPtyIdRef.current = ptyId;
  }, [ptyId]);

  // Sync isCliReady from panel prop when it changes (e.g. backend persisted isCliReady
  // before this component subscribed to the IPC event, or panel state was updated externally)
  useEffect(() => {
    isCliPanelRef.current = isCliPanel;
  }, [isCliPanel]);

  useEffect(() => {
    if (terminalState?.isCliReady && !isCliReady) {
      setIsCliReady(true);
    }
  }, [terminalState?.isCliReady, isCliReady]);

  // Listen for cliReady event (only for CLI panels that aren't already ready)
  useEffect(() => {
    if (!isCliPanel || isCliReady) return;
    const cleanup = window.electronAPI.events.onTerminalCliReady((data) => {
      if (data.panelId === panel.id) {
        setIsCliReady(true);
      }
    });
    return cleanup;
  }, [panel.id, isCliPanel, isCliReady]);

  // Listen for the ptyHost ptyId assignment. The main process fires this
  // once per spawn when the `usePtyHost` setting is on; fires again on auto-reattach
  // after a supervisor restart with a new ptyId. Updating state triggers the
  // data-subscription effect below to tear down and re-subscribe.
  useEffect(() => {
    const cleanup = window.electronAPI.events.onTerminalPtyReady((data) => {
      if (data.panelId === panel.id) {
        setPtyId(data.ptyId);
      }
    });
    return cleanup;
  }, [panel.id]);

  // Subscribe to the ptyHost MessagePort data stream for this panel when we
  // have a `ptyId`. Flag-off panels keep the legacy `terminal:output` IPC
  // subscription installed inside the main init effect and skip this effect
  // entirely. Re-subscribes when `ptyId` changes (auto-reattach after a
  // supervisor restart).
  useEffect(() => {
    if (!ptyId) return;
    const unsubData = window.electronAPI.ptyHost.onData(ptyId, (data: string) => {
      outputConsumerRef.current?.write(data);
    });
    return unsubData;
  }, [ptyId]);

  // Get session data from context using the safe hook
  const sessionContext = useSession();
  const sessionId = sessionContext?.sessionId;
  const workingDirectory = sessionContext?.workingDirectory;
  const { theme } = useTheme();
  
  if (sessionContext) {
    devLog.debug('[TerminalPanel] Session context:', sessionContext);
  } else {
    devLog.error('[TerminalPanel] No session context available');
  }

  // Keep isActiveRef in sync with isActive prop
  useEffect(() => {
    isActiveRef.current = panelVisible;
  }, [panelVisible]);

  useEffect(() => {
    let disposed = false;
    window.electronAPI.window?.isFocused?.()
      .then((focused) => {
        if (!disposed) setWindowFocused(focused);
      })
      .catch(() => {
        // Default to focused if the focus query is unavailable.
      });

    const cleanup = window.electronAPI.events.onWindowFocusChanged((focused) => {
      setWindowFocused(focused);
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  const forwardToMainLog = useCallback((level: 'info' | 'warn', message: string) => {
    try {
      window.electronAPI.invoke('console:log', {
        level,
        args: [message],
        timestamp: new Date().toISOString(),
        source: 'renderer',
        toMainLog: true,
      });
    } catch {
      // IPC failure shouldn't break terminal lifecycle work.
    }
  }, []);

  const loadWebglRenderer = useCallback(async (terminal: Terminal, isDisposed: () => boolean, reason = 'visible') => {
    if (webglAddonRef.current) return;
    try {
      const { WebglAddon: WebglAddonImpl } = await import('@xterm/addon-webgl');
      if (isDisposed() || webglAddonRef.current) return;
      const addon = new WebglAddonImpl();
      addon.onContextLoss(() => {
        console.warn('[TerminalPanel] WebGL context lost for panel', panel.id, ', falling back to DOM renderer');
        forwardToMainLog('warn', `[TerminalPanel] WebGL context lost for panel ${panel.id}, falling back to DOM renderer`);
        try { addon.dispose(); } catch { /* already disposed */ }
        webglAddonRef.current = null;
        // Defense-in-depth: force a redraw on the restored DOM renderer.
        const fallbackTerminal = xtermRef.current;
        if (fallbackTerminal && fallbackTerminal.rows > 0) {
          fallbackTerminal.refresh(0, fallbackTerminal.rows - 1);
        }
      });
      terminal.loadAddon(addon);
      webglAddonRef.current = addon;
      // xterm's activate() only swaps the renderer via setRenderer with no full
      // row refresh, so force a redraw on the freshly attached WebGL renderer —
      // deferred past the next paint: refreshing in the same task can hit an
      // uncomposited canvas on blur→refocus reattach.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (webglAddonRef.current !== addon) return;
        if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
      }));
      console.log('[TerminalPanel] WebGL renderer loaded for panel', panel.id);
      forwardToMainLog('info', `[TerminalPanel] WebGL renderer loaded for panel ${panel.id} reason=${reason}`);
    } catch (e) {
      console.warn('[TerminalPanel] WebGL renderer failed for panel', panel.id, ', using DOM renderer:', e);
      forwardToMainLog('warn', `[TerminalPanel] WebGL renderer failed for panel ${panel.id}, using DOM renderer: ${e instanceof Error ? e.message : String(e)}`);
      webglAddonRef.current = null;
    }
  }, [forwardToMainLog, panel.id]);

  const disposeWebglRenderer = useCallback((reason = 'hidden') => {
    if (!webglAddonRef.current) return;
    try { webglAddonRef.current.dispose(); } catch { /* ignore */ }
    webglAddonRef.current = null;
    forwardToMainLog('info', `[TerminalPanel] WebGL renderer detached for panel ${panel.id} reason=${reason}`);
  }, [forwardToMainLog, panel.id]);

  // Replaces the old 30 s snapshot interval: fire once on active-to-inactive
  // transitions (tab switches / panel hides), throttled so rapid tab flips
  // don't do a full buffer walk + IPC each time. The dispose-time snapshot in
  // the terminal init effect stays as a backstop for full unmount.
  const wasActiveRef = useRef(panelVisible);
  const lastSnapshotAtRef = useRef(0);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = panelVisible;
    if (wasActive && !panelVisible && serializeAddonRef.current) {
      if (Date.now() - lastSnapshotAtRef.current < SNAPSHOT_MIN_INTERVAL_MS) return;
      try {
        const serialized = serializeAddonRef.current.serialize();
        window.electronAPI.invoke('terminal:saveSnapshot', panel.id, serialized);
        lastSnapshotAtRef.current = Date.now();
      } catch {
        // xterm buffer in a bad state — not worth surfacing
      }
    }
  }, [panelVisible, panel.id]);

  // Tell main when this panel's visibility changes so PTY output cadence
  // can drop to 250 ms while hidden and snap back to 32 ms when shown.
  // Gate on isInitialized so panels that mount inactive (hidden background
  // sessions) actually deliver the signal — main's no-op-on-missing guard
  // would drop it otherwise. isInitialized in deps ensures re-fire with the
  // current isActive the moment the PTY exists.
  useEffect(() => {
    if (!isInitialized) return;
    window.electronAPI.invoke('terminal:setVisibility', panel.id, effectiveVisible, TERMINAL_VISIBILITY_VIEWER_ID);

    if (!effectiveVisible) {
      hotActivationEligibleRef.current = false;
      hotActivationPendingRef.current = false;
      return;
    }
    const refreshTimer = setInterval(() => {
      window.electronAPI.invoke('terminal:setVisibility', panel.id, true, TERMINAL_VISIBILITY_VIEWER_ID);
    }, TERMINAL_VISIBILITY_REFRESH_MS);

    return () => clearInterval(refreshTimer);
  }, [effectiveVisible, panel.id, isInitialized]);

  // WebGL policy: detach immediately when the panel hides, keep it attached
  // through short app blurs, and detach after a sustained app blur while
  // arming full recovery for the renderer swap on refocus.
  useEffect(() => {
    if (blurDetachTimerRef.current) {
      clearTimeout(blurDetachTimerRef.current);
      blurDetachTimerRef.current = null;
    }

    if (!panelVisible) {
      // Capture eligibility before detaching WebGL. The xterm remains mounted and
      // performance mode continues delivering output while this panel is hidden.
      hotActivationPendingRef.current = hotActivationEligibleRef.current && !useBatterySaverTerminalVisibility;
      if (!hotActivationPendingRef.current) {
        needsFullActivationRefreshRef.current = true;
      }
      setWebglAllowed(false);
      disposeWebglRenderer('panel-hidden');
      return;
    }

    if (windowFocused) {
      setWebglAllowed(true);
      return;
    }

    setWebglAllowed(true);
    blurDetachTimerRef.current = setTimeout(() => {
      blurDetachTimerRef.current = null;
      needsFullActivationRefreshRef.current = true;
      hotActivationEligibleRef.current = false;
      hotActivationPendingRef.current = false;
      setWebglAllowed(false);
      disposeWebglRenderer('app-blur-timeout');
    }, WEBGL_APP_BLUR_DETACH_DELAY_MS);

    return () => {
      if (blurDetachTimerRef.current) {
        clearTimeout(blurDetachTimerRef.current);
        blurDetachTimerRef.current = null;
      }
    };
  }, [panelVisible, windowFocused, useBatterySaverTerminalVisibility, disposeWebglRenderer]);

  useEffect(() => {
    if (!isInitialized || !xtermRef.current) return;
    if (!webglAllowed || !panelVisible) {
      disposeWebglRenderer(panelVisible ? 'webgl-not-allowed' : 'panel-hidden');
      return;
    }

    let disposed = false;
    void loadWebglRenderer(xtermRef.current, () => disposed, windowFocused ? 'visible' : 'short-app-blur');
    return () => {
      disposed = true;
    };
  }, [webglAllowed, panelVisible, windowFocused, isInitialized, disposeWebglRenderer, loadWebglRenderer]);

  // Terminal link handling hook
  const {
    onMouseMove,
    tooltip,
    filePopover,
    selectionPopover,
    handleOpenInEditor,
    handleOpenInBrowser,
    handleShowInExplorer,
    closeFilePopover,
    closeSelectionPopover,
  } = useTerminalLinks(xtermRef.current, {
    workingDirectory: workingDirectory || '',
    sessionId: sessionId || panel.sessionId,
  });

  // Terminal search hook
  const {
    isSearchOpen,
    searchQuery,
    searchStatus,
    searchInputRef,
    openSearch,
    closeSearch,
    onQueryChange,
    onStep,
  } = useTerminalSearch(xtermRef);

  const resizePtyToFit = useCallback(async (force = false): Promise<void> => {
    if (!fitAddonRef.current || !terminalRef.current) return;
    // Guard before fit(): the renderer grid is the damage point, not just the IPC.
    // Width only: wrap junk is a cols problem, and a stacked pane at Allotment's
    // 120px minSize minus tab-bar chrome leaves a legitimately <100px-tall container.
    const rect = terminalRef.current.getBoundingClientRect();
    if (rect.width < MIN_VIABLE_RECT_PX) return;
    fitAddonRef.current.fit();
    const dimensions = fitAddonRef.current.proposeDimensions();
    if (
      !dimensions ||
      !Number.isInteger(dimensions.cols) || !Number.isInteger(dimensions.rows) ||
      dimensions.cols < MIN_PTY_COLS || dimensions.rows < MIN_PTY_ROWS
    ) {
      return;
    }

    if (!force) {
      await window.electronAPI.invoke(
        'terminal:resize',
        panel.id,
        dimensions.cols,
        dimensions.rows,
        { force },
      );
      return;
    }

    const terminal = xtermRef.current;
    if (!terminal) return;
    const redrawCols = dimensions.cols > MIN_PTY_COLS ? dimensions.cols - 1 : dimensions.cols + 1;

    try {
      // Keep renderer and PTY geometry synchronized throughout the forced redraw.
      // Full recovery/manual refresh already run under the opaque spinner mask.
      terminal.resize(redrawCols, dimensions.rows);
      await window.electronAPI.invoke(
        'terminal:resize',
        panel.id,
        redrawCols,
        dimensions.rows,
      );
      await new Promise(resolve => setTimeout(resolve, FORCED_REDRAW_TRANSITION_MS));
      terminal.resize(dimensions.cols, dimensions.rows);
      await window.electronAPI.invoke(
        'terminal:resize',
        panel.id,
        dimensions.cols,
        dimensions.rows,
        { force },
      );
    } finally {
      // An IPC failure must not strand the renderer at the redraw dimensions.
      if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) {
        terminal.resize(dimensions.cols, dimensions.rows);
      }
    }
  }, [panel.id]);

  // Full-depth refresh: normal buffers reset+replay main's raw scrollback at the
  // settled width; alternate buffers preserve their live model. Both paths end
  // with a forced PTY resize so foreground applications redraw even when the
  // dimensions did not change. Runs on initial construction, remount/session
  // switch, battery-saver activation, sustained-blur recovery, and manual
  // Refresh. Eligible same-session hot activations use reconcileMountedTerminal
  // instead and never enter this function.
  const handleRefreshTerminal = useCallback(async () => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    // Entry guard: never reset+replay into a tiny/unsettled container (width only,
    // matching resizePtyToFit: height-constrained panes are legitimate layouts)
    const rect = terminalRef.current?.getBoundingClientRect();
    if (!rect || rect.width < MIN_VIABLE_RECT_PX) return;
    try {
      const scrollSnapshot = (() => {
        const buffer = terminal.buffer.active;
        const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
        return {
          distanceFromBottom,
          wasNearBottom: isNearBottomRef.current || distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_ROWS,
        };
      })();
      const restoreScrollPosition = () => {
        if (scrollSnapshot.wasNearBottom) {
          terminal.scrollToBottom();
          isNearBottomRef.current = true;
          setShowScrollDown(false);
          return;
        }

        const targetLine = Math.max(0, terminal.buffer.active.baseY - scrollSnapshot.distanceFromBottom);
        terminal.scrollToLine(targetLine);
        isNearBottomRef.current = false;
        setShowScrollDown(true);
      };

      const state = await window.electronAPI.invoke('terminal:getState', panel.id);
      if (state?.isAlternateScreen) {
        // Renderer refresh alone cannot repair an application frame that was
        // restored before the visible grid settled. Move xterm and the PTY through
        // the same one-column transition so the foreground app receives a real
        // resize notification without a renderer/PTY geometry mismatch.
        await resizePtyToFit(true);
        if (terminal.rows > 0) {
          terminal.refresh(0, terminal.rows - 1);
        }
        restoreScrollPosition();
        return;
      }

      // Fit first so reset+replay lands at the settled width, not a stale/tiny grid
      await resizePtyToFit();
      terminal.reset();
      const finishRefresh = async () => {
        restoreScrollPosition();
        // The old post-replay fit() invalidated WebGL via a dims change; after reordering
        // that fit is a same-size no-op, so an explicit refresh is needed for WebGL redraw
        if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
        // Claude's default renderer can remain in the normal buffer while still
        // needing the same application redraw as a fullscreen alternate-buffer TUI.
        await resizePtyToFit(true);
      };

      if (state?.scrollbackBuffer) {
        const content = typeof state.scrollbackBuffer === 'string'
          ? state.scrollbackBuffer
          : Array.isArray(state.scrollbackBuffer)
            ? state.scrollbackBuffer.join('\n')
            : '';
        if (content) {
          await new Promise<void>((resolve, reject) => {
            terminal.write(content, () => {
              void finishRefresh().then(resolve, reject);
            });
          });
          return;
        }
      }
      await finishRefresh();
    } catch (e) {
      console.warn('[TerminalPanel] Failed to refresh terminal:', e);
    }
  }, [panel.id, resizePtyToFit]);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await handleRefreshTerminal();
      await waitForNextPaint();
      await new Promise(resolve => setTimeout(resolve, TERMINAL_ACTIVATION_MASK_AFTER_PAINT_MS));
    } finally {
      setIsRefreshing(false);
    }
  }, [handleRefreshTerminal]);

  // Light repaint for pure-refocus activations (buffer is live, only pixels are
  // stale). Pattern: the theme effect's guarded refresh minus its unconditional
  // scrollToBottom. Snapshot/restore scroll around the fit, mirroring
  // handleRefreshTerminal's alt-screen path: fit() is a no-op when dims are
  // unchanged, but a refocus coinciding with a window resize reflows the buffer
  // and would otherwise shift a scrolled-up shell.
  const reconcileMountedTerminal = useCallback(async (): Promise<void> => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
    const wasNearBottom = isNearBottomRef.current || distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_ROWS;

    await resizePtyToFit();
    if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);

    if (wasNearBottom) {
      terminal.scrollToBottom();
      isNearBottomRef.current = true;
      setShowScrollDown(false);
    } else {
      terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - distanceFromBottom));
      isNearBottomRef.current = false;
      setShowScrollDown(true);
    }
  }, [resizePtyToFit]);

  const repaintTerminal = useCallback(() => {
    void reconcileMountedTerminal();
  }, [reconcileMountedTerminal]);

  // Open search on Ctrl/Cmd+F from the container div
  const handleTerminalKeyDown = useCallback((e: React.KeyboardEvent) => {
    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    if (ctrlOrMeta && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
    }
  }, [openSearch]);

  const getDropdownPosition = useCallback((): { x: number; y: number } => {
    const container = terminalRef.current;
    const terminal = xtermRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();

    // Position near the cursor row. The dropdown's viewport clamping will
    // flip it above the cursor line if there isn't enough room below.
    if (terminal) {
      const cursorY = terminal.buffer.active.cursorY;
      const totalRows = terminal.rows;
      // Approximate row height from container height
      const rowHeight = rect.height / totalRows;
      return {
        x: rect.left + 16,
        y: rect.top + cursorY * rowHeight,
      };
    }

    // Fallback: bottom of terminal
    return {
      x: rect.left + 16,
      y: rect.bottom - 40,
    };
  }, []);

  // Initialize terminal only once when component first mounts
  // Keep it alive even when switching sessions
  useEffect(() => {
    devLog.debug('[TerminalPanel] Initialization useEffect running, terminalRef:', terminalRef.current);

    if (!terminalRef.current) {
      devLog.debug('[TerminalPanel] Missing terminal ref, skipping initialization');
      return;
    }

    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let disposed = false;

    const initializeTerminal = async () => {
      try {
        devLog.debug('[TerminalPanel] Starting initialization for panel:', panel.id);

        // Check if already initialized on backend
        const initialized = await window.electronAPI.invoke('panels:checkInitialized', panel.id);
        console.log('[TerminalPanel] Panel already initialized?', initialized);

        // Store terminal state for THIS panel only (not in global variable)
        let terminalStateForThisPanel: TerminalRestoreState | null = null;

        if (!initialized) {
          // Initialize backend PTY process
          console.log('[TerminalPanel] Initializing backend PTY process...');
          // Use workingDirectory and sessionId if available, but don't require them
          // Use actual container dimensions for PTY spawn (falls back to 80x30 on backend)
          const containerRect = terminalRef.current?.getBoundingClientRect();
          const estimatedCols = containerRect ? Math.floor(containerRect.width / 8) : undefined; // rough char width estimate
          const estimatedRows = containerRect ? Math.floor(containerRect.height / 17) : undefined; // rough char height estimate
          await window.electronAPI.invoke('panels:initialize', panel.id, {
            cwd: workingDirectory || process.cwd(),
            sessionId: sessionId || panel.sessionId,
            cols: estimatedCols && estimatedCols >= 20 ? estimatedCols : undefined,
            rows: estimatedRows && estimatedRows >= 5 ? estimatedRows : undefined,
          });
          console.log('[TerminalPanel] Backend PTY process initialized');
        } else {
          // Terminal is already initialized, get its state to restore scrollback
          console.log('[TerminalPanel] Restoring terminal state from backend...');
          const terminalState = await window.electronAPI.invoke('terminal:getState', panel.id);
          if (terminalState && selectTerminalRestoreContent(terminalState)) {
            // We'll restore this to the terminal after it's created
            console.log('[TerminalPanel] Found terminal restore state');
            // Store for restoration after terminal is created - LOCAL to this initialization
            terminalStateForThisPanel = terminalState;
          }
        }

        // FIX: Check if component was unmounted during async operation
        if (disposed) return;

        // Read terminal font config
        let terminalFontFamily = DEFAULT_TERMINAL_FONT_FAMILY;
        let terminalFontSize = DEFAULT_TERMINAL_FONT_SIZE;
        try {
          const configResult = await window.electronAPI.config.get();
          if (configResult?.data) {
            terminalFontFamily = configResult.data.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
            terminalFontSize = configResult.data.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE;
          }
        } catch {
          // Config read failed — use defaults
        }

        // FIX: Check if component was unmounted during async config read
        if (disposed) return;

        // Create XTerm instance
        console.log('[TerminalPanel] Creating XTerm instance...');
        terminal = new Terminal({
          fontSize: terminalFontSize,
          fontFamily: buildTerminalFontFamily(terminalFontFamily),
          theme: getTerminalTheme(),
          scrollback: 2500,
          cursorBlink: false,
          cursorStyle: 'block',
          cursorWidth: 1,
          cursorInactiveStyle: 'outline',
          allowTransparency: false,
          scrollOnUserInput: true,
          scrollSensitivity: 1,
          altClickMovesCursor: true,
          drawBoldTextInBrightColors: true,
          rescaleOverlappingGlyphs: true,
          minimumContrastRatio: document.documentElement.classList.contains('light') ? 4.5 : 1,
          macOptionIsMeta: false,
          linkHandler: {
            activate: (_event, uri) => {
              void window.electronAPI.openExternal(uri).catch((error: unknown) => {
                console.error('[TerminalPanel] Failed to open terminal link:', error);
              });
            },
          },
        });
        console.log('[TerminalPanel] XTerm instance created:', !!terminal);

        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        console.log('[TerminalPanel] FitAddon loaded');

        // Intercept app-level shortcuts before xterm consumes them
        terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          const ctrlOrMeta = e.ctrlKey || e.metaKey;

          // Ctrl/Cmd+K: clear xterm scrollback without writing ^K to the PTY.
          if (ctrlOrMeta && e.key.toLowerCase() === 'k') {
            if (e.type === 'keydown') {
              xtermRef.current?.clear();
              window.electronAPI
                .invoke('terminal:clearScrollback', panel.id)
                .catch((error: unknown) => {
                  console.warn('[TerminalPanel] Failed to persist scrollback clear:', error);
                });
            }
            return false;
          }

          const terminalKeyDecision = resolveTerminalKeyHandling(e, {
            isTuiActive: tuiActiveRef.current,
            isCliPanel: isCliPanelRef.current,
          });

          // Shift+Enter sends the same ESC+CR sequence as Alt+Enter for CLI
          // composers. In fullscreen agent TUIs this must run before generic
          // passthrough, while ordinary TUIs still receive Shift+Enter directly.
          if (terminalKeyDecision.action === 'send-input') {
            if (e.type === 'keydown') {
              window.electronAPI.invoke('terminal:input', panel.id, terminalKeyDecision.input);
            }
            return false;
          }
          if (terminalKeyDecision.action === 'block') return false;
          if (terminalKeyDecision.action === 'pass-through') return true;

          // Ctrl/Cmd+1-9: switch sessions
          if (ctrlOrMeta && e.key >= '1' && e.key <= '9') return false;
          // Ctrl+Alt+1-9: switch panel tabs
          if (ctrlOrMeta && e.altKey && e.key >= '1' && e.key <= '9') return false;
          // Ctrl/Cmd+Alt+letter: terminal shortcuts — only release if a matching hotkey is registered
          // Use e.code instead of e.key because macOS Option key modifies e.key to special chars
          // (e.g. Option+A produces e.key='å' but e.code='KeyA')
          // Skip AltGr — on Windows/Linux international layouts AltGr sets both ctrlKey+altKey
          // but is used for character input (e.g. AltGr+Q = '@' on German keyboards)
          if (ctrlOrMeta && e.altKey && !e.getModifierState('AltGraph') && /^Key[A-Z]$/.test(e.code)) {
            const pressed = `mod+alt+${e.code.slice(3).toLowerCase()}`;
            const hotkeys = useHotkeyStore.getState().hotkeys;
            for (const def of hotkeys.values()) {
              if (def.keys === pressed) return false;
            }
          }
          // Ctrl/Cmd+Alt+/: open shortcut settings
          // Check e.code too: macOS Option modifies e.key (e.g. '/' becomes '÷')
          if (ctrlOrMeta && e.altKey && (e.key === '/' || (!e.getModifierState('AltGraph') && e.code === 'Slash'))) return false;
          // Ctrl/Cmd+W or Ctrl/Cmd+Q: close active tab
          if (ctrlOrMeta && (e.key.toLowerCase() === 'w' || e.key.toLowerCase() === 'q')) return false;
          // Ctrl/Cmd+T: open Add Tool dropdown
          if (ctrlOrMeta && e.key.toLowerCase() === 't') return false;
          // Ctrl/Cmd+P: prompt history; Ctrl/Cmd+Shift+P: command palette
          if (ctrlOrMeta && e.key.toLowerCase() === 'p') return false;
          // Ctrl/Cmd+N: new workspace
          if (ctrlOrMeta && e.key.toLowerCase() === 'n') return false;
          // Ctrl/Cmd+Shift+D: toggle diff
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'd') return false;
          // Ctrl/Cmd+Shift+R: toggle run
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'r') return false;
          // Git shortcuts - release to DOM for hotkeyStore
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'm') return false;
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'u') return false;
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'l') return false;
          // Ctrl/Cmd+Shift+N: new project
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'n') return false;

          // Session cycling - Tab
          if (ctrlOrMeta && e.key === 'Tab') return false;
          // Session cycling - Ctrl+Up/Down arrows
          if (ctrlOrMeta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return false;
          // Tab cycling - Ctrl+A/D
          if (ctrlOrMeta && (e.key.toLowerCase() === 'a' || e.key.toLowerCase() === 'd')) return false;
          // Ctrl/Cmd+B: toggle sidebar
          if (ctrlOrMeta && e.key.toLowerCase() === 'b') return false;
          // Ctrl/Cmd+Shift+digit: panel tab switching (use e.code for layout independence)
          if (ctrlOrMeta && e.shiftKey && /^Digit[1-9]$/.test(e.code)) return false;
          // Ctrl/Cmd+Alt+digit: add tool shortcuts (skip AltGr — used for @/€ etc. on EU layouts)
          if (ctrlOrMeta && e.altKey && !e.getModifierState('AltGraph') && /^Digit[1-9]$/.test(e.code)) return false;
          // Ctrl/Cmd+`: toggle bottom terminal
          if (ctrlOrMeta && e.key === '`') return false;
          // Ctrl/Cmd+,: open settings
          if (ctrlOrMeta && e.key === ',') return false;
          // Ctrl/Cmd+Shift+E: focus sidebar
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'e') return false;

          // Split tab groups: Mod+\ and Mod+Shift+\ (Ctrl+\ is SIGQUIT - must release!)
          // ISO/international keyboards report the key as IntlBackslash.
          // On macOS the app hotkey is Cmd+\, so only release metaKey there
          // and let Ctrl+\ keep delivering SIGQUIT to the PTY.
          if ((isMac() ? e.metaKey : e.ctrlKey) && (e.code === 'Backslash' || e.code === 'IntlBackslash')) return false;
          // Zoom toggle: Mod+Shift+Z
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'z') return false;
          // Directional group focus: Mod+Alt+Arrows (all four directions)
          if (ctrlOrMeta && e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return false;

          // Detect AltGr+key producing '@' (e.g. German AltGr+Q) — set flag so the
          // interceptor skips activation for this keystroke. AltGr sets both ctrlKey+altKey
          // on Windows/Linux, or e.getModifierState('AltGraph') on some platforms.
          if (e.key === '@' && (e.getModifierState('AltGraph') || (e.ctrlKey && e.altKey))) {
            skipNextInterceptRef.current = true;
          }

          // Right Alt: let OS/browser handle (e.g. voice transcription, IME)
          // Use e.code for physical key (e.key may report 'AltGraph' on some layouts)
          if (e.code === 'AltRight') return false;

          // Ctrl/Cmd+F: terminal search
          if (ctrlOrMeta && e.key.toLowerCase() === 'f') return false;

          // Ctrl/Cmd+V: stop xterm from sending raw \x16 to PTY
          // Returning false lets the browser trigger a native paste event instead,
          // which is handled by our paste event listener on the terminal container
          if (ctrlOrMeta && e.key.toLowerCase() === 'v') return false;

          return true; // Let terminal handle everything else
        });

        // FIX: Additional check before DOM manipulation
        if (terminalRef.current && !disposed) {
          console.log('[TerminalPanel] Opening terminal in DOM element:', terminalRef.current);
          terminal.open(terminalRef.current);
          console.log('[TerminalPanel] Terminal opened in DOM');

          // Wait for fonts to load before fitting so xterm measures correct cell dimensions
          await Promise.all([
            document.fonts.load(`${terminalFontSize}px "${terminalFontFamily}"`).catch(() => {}),
            document.fonts.load(`${terminalFontSize}px "Symbols Nerd Font Mono"`).catch(() => {}),
          ]);
          // Never fit against a hidden/mid-layout container (display:none keep-alive
          // tabs measure 0×0): FitAddon resizes the grid with no floor, and background
          // PTY output then parses into a garbage-width buffer that reflow can't fix.
          // Keeping xterm's default grid matches the PTY's default cols; the one-time
          // full activation refresh rebuilds anything that still parsed mismatched.
          if ((terminalRef.current?.getBoundingClientRect().width ?? 0) >= MIN_VIABLE_RECT_PX) {
            fitAddon.fit();
            console.log('[TerminalPanel] FitAddon fitted');
          } else {
            needsFullActivationRefreshRef.current = true;
            console.log('[TerminalPanel] Skipped mount fit (hidden container); armed full activation refresh');
          }
          terminal.options.theme = getTerminalTheme();

          // Load WebLinksAddon for clickable URLs
          try {
            const { WebLinksAddon: WebLinksAddonImpl } = await import('@xterm/addon-web-links');
            if (!disposed) {
              const isMac = navigator.platform.toUpperCase().includes('MAC');
              const webLinksAddon = new WebLinksAddonImpl((event, uri) => {
                // Only open link if Ctrl (Windows/Linux) or Cmd (Mac) is held
                if (isMac ? event.metaKey : event.ctrlKey) {
                  window.electronAPI.openExternal(uri);
                }
              });
              terminal.loadAddon(webLinksAddon);
              webLinksAddonRef.current = webLinksAddon;
              console.log('[TerminalPanel] WebLinksAddon loaded for panel', panel.id);
            }
          } catch (e) {
            console.warn('[TerminalPanel] WebLinksAddon failed to load for panel', panel.id, ':', e);
            webLinksAddonRef.current = null;
          }

          // Load SerializeAddon for terminal snapshot persistence
          try {
            const { SerializeAddon: SerializeAddonImpl } = await import('@xterm/addon-serialize');
            if (!disposed) {
              const serializeAddon = new SerializeAddonImpl();
              terminal.loadAddon(serializeAddon);
              serializeAddonRef.current = serializeAddon;
              console.log('[TerminalPanel] SerializeAddon loaded for panel', panel.id);
            }
          } catch (e) {
            console.warn('[TerminalPanel] SerializeAddon failed to load for panel', panel.id, ':', e);
            serializeAddonRef.current = null;
          }

          // Load Unicode11Addon for better emoji/unicode width calculation
          try {
            const { Unicode11Addon: Unicode11AddonImpl } = await import('@xterm/addon-unicode11');
            if (!disposed) {
              const unicode11Addon = new Unicode11AddonImpl();
              terminal.loadAddon(unicode11Addon);
              terminal.unicode.activeVersion = '11';
              unicode11AddonRef.current = unicode11Addon;
              console.log('[TerminalPanel] Unicode11Addon loaded for panel', panel.id);
            }
          } catch (e) {
            console.warn('[TerminalPanel] Unicode11Addon failed to load for panel', panel.id, ':', e);
            unicode11AddonRef.current = null;
          }

          xtermRef.current = terminal;
          fitAddonRef.current = fitAddon;

          // Track scroll position with direction-based sticky behaviour.
          // Also snap to true bottom when the user scrolls close enough — xterm's mouse
          // wheel sometimes stops 1-2 lines short of baseY, leaving the prompt just
          // out of view. Snapping within a small threshold fixes the "can't reach input" feel.
          const terminalInstance = terminal;
          const SNAP_THRESHOLD = NEAR_BOTTOM_THRESHOLD_ROWS; // lines — for the "can't reach input" snap fix
          let prevDistFromBottom = 0;
          const scrollDisposable = terminalInstance.onScroll(() => {
            const buf = terminalInstance.buffer.active;
            const dist = buf.baseY - buf.viewportY;

            if (dist === 0) {
              // User is at the very bottom — enable sticky
              isNearBottomRef.current = true;
              setShowScrollDown(false);
            } else if (dist > prevDistFromBottom) {
              // User scrolled UP — they want to read history, disable sticky
              isNearBottomRef.current = false;
              setShowScrollDown(true);
            }
            // If scrolling down but not at bottom yet, leave sticky as-is
            // Note: programmatic writes may shift baseY and fire onScroll with changed dist.
            // The direction heuristic is not perfect for those events, but is correct
            // for the primary case (user mouse-wheel / trackpad scrolls).

            prevDistFromBottom = dist;

            // Snap: if user scrolled to within a few lines of bottom, go all the way
            // (fixes mouse wheel stopping 1-2 lines short of actual bottom)
            // Only snap if sticky is already engaged — don't re-engage for a user
            // who scrolled up and is scrolling back down manually.
            if (isNearBottomRef.current && dist > 0 && dist <= SNAP_THRESHOLD) {
              terminalInstance.scrollToBottom();
            }
          });

          // Ack batching for flow control
          const ACK_BATCH_SIZE = 5_000; // 5KB - aligned with main LOW_WATERMARK per VS Code FlowControlConstants
          const ACK_BATCH_INTERVAL = 100; // ms
          let pendingAckBytes = 0;
          let ackFlushTimer: ReturnType<typeof setTimeout> | null = null;

          const flushAck = () => {
            if (ackFlushTimer) {
              clearTimeout(ackFlushTimer);
              ackFlushTimer = null;
            }
            if (pendingAckBytes > 0) {
              const bytes = pendingAckBytes;
              pendingAckBytes = 0;
              // Under the ptyHost flag, ack over the per-window MessagePort so it
              // bypasses the main IPC invoke queue. Flag-off keeps the legacy
              // IPC path. `currentPtyIdRef` is a ref because the ptyId can change
              // across auto-reattach after a supervisor restart.
              const activePtyId = currentPtyIdRef.current;
              if (activePtyId) {
                window.electronAPI.ptyHost.ack(activePtyId, bytes);
              } else {
                window.electronAPI.invoke('terminal:ack', panel.id, bytes);
              }
            }
          };

          // Snapshot persistence: see the active-to-inactive effect below and
          // the dispose-time snapshot in this effect's cleanup. The previous
          // 30 s interval was removed to stop hidden panels from doing a full
          // buffer walk + IPC payload once per half-minute for no visible gain.

          // Restore the active buffer for this panel. Full-screen TUIs render in
          // xterm's alternate buffer, so normal shell scrollback is not a valid
          // representation while alternate-screen mode is active.
          if (terminalStateForThisPanel) {
            const restore = selectTerminalRestoreContent(terminalStateForThisPanel);
            if (restore) {
              console.log('[TerminalPanel] Restoring', restore.content.length, 'chars from', restore.source);
              terminal.write(restore.content);
            }
            // Force WebGL renderer to redraw after buffer content changes.
            // Without this, macOS WebGL canvas shows stale/stuttered content until
            // a resize event (minimize/fullscreen) forces invalidation.
            // Same hidden-container guard as the mount fit: WebGL isn't attached
            // while hidden, and a 0-width fit would mangle the grid.
            if ((terminalRef.current?.getBoundingClientRect().width ?? 0) >= MIN_VIABLE_RECT_PX) {
              fitAddon.fit();
            }
          }

          // Handle paste events (Ctrl+V, voice transcription, external text injection)
          // Attached on the container in CAPTURE phase so we fire BEFORE xterm's textarea
          // handler. This is required for correct image paste in packaged builds: when
          // pasting a screenshot on Windows the clipboard contains both the image bitmap
          // AND a text/plain representation (e.g. "[Image]"). If xterm's handler fires
          // first it pastes that text before we can intercept, and our old `!text` fallback
          // condition was then false — so the Electron clipboard IPC was never called and
          // no image path was pasted.
          //
          // Strategy:
          //   1. Check browser clipboardData.items for an image (fast path, works on
          //      native Windows/macOS when Chromium exposes the bitmap).
          //   2. If not found, always try terminal:clipboard-paste-image (Electron's native
          //      clipboard API, works for WSL screenshots and any case where Chromium
          //      doesn't expose the image in items).  We capture the text from clipboardData
          //      first so we can forward it manually if the Electron check finds no image.
          //   3. If Electron clipboard has no image either, call terminal.paste(text) to
          //      forward the text content — this replaces the xterm handler we blocked.
          // Paste handler: we always paste the raw file path (no "[Image] " prefix).
          // Claude Code CLI's paste parser auto-detects bare image file paths and
          // attaches them as [Image #N] in the next API message on every platform.
          // The "[Image] " prefix we used to add actually broke the parser's
          // path-detection — on Windows+WSL it caused Claude to cache the file but
          // never attach it to the API call (see commit 7b76ee5).
          const pasteText = (text: string) => {
            if (!terminal) return;
            const shouldProtectMultilinePaste = isCliPanelRef.current && !tuiActiveRef.current && /[\r\n]/.test(text);
            if (shouldProtectMultilinePaste) {
              window.electronAPI.invoke(
                'terminal:input',
                panel.id,
                text.replace(/\r\n|\r|\n/g, '\x1b\r'),
              );
              return;
            }

            terminal.paste(text);
          };

          const handlePaste = (e: ClipboardEvent) => {
            // Step 1: Check for images in browser clipboard (works on native Windows/macOS)
            const items = e.clipboardData?.items;
            const textVal = e.clipboardData?.getData('text') ?? '';
            if (items) {
              for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/')) {
                  e.stopPropagation();
                  e.preventDefault();
                  const file = items[i].getAsFile();
                  if (!file) return;

                  if (file.size > 50 * 1024 * 1024) {
                    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
                    if (terminal && !disposed) {
                      terminal.paste(`[Image paste failed] File too large (${sizeMB} MB), max 50 MB\n`);
                    }
                    return;
                  }

                  const reader = new FileReader();
                  reader.onload = async (ev) => {
                    if (disposed || !terminal) return;
                    const dataUrl = ev.target?.result as string;
                    if (!dataUrl) return;

                    try {
                      const result = await window.electronAPI.invoke(
                        'terminal:paste-image',
                        panel.id,
                        sessionId || panel.sessionId,
                        dataUrl,
                        file.type
                      ) as { filePath: string; imageNumber: number } | null;
                      if (result?.filePath && !disposed && terminal) {
                        terminal.paste(`${result.filePath}\n`);
                      }
                    } catch (err) {
                      console.error('[TerminalPanel] Failed to paste image:', err);
                    }
                  };
                  reader.readAsDataURL(file);
                  return;
                }
              }
            }

            // Step 2: No image in browser clipboard. Capture text now (before any
            // preventDefault clears it), block xterm, then check the Electron clipboard.
            // We always check regardless of whether text is present — the old `!text`
            // guard caused silent failures when Windows put "[Image]" in text/plain
            // alongside the actual bitmap (making text non-empty, skipping the fallback).
            const text = textVal;
            e.stopPropagation();
            e.preventDefault();

            if (isRemoteMode) {
              if (text && !isClipboardImagePlaceholderText(text) && !disposed && terminal) {
                terminal.paste(text);
              } else {
                setToastMessage('Native image clipboard paste is unavailable in remote mode. Use drag and drop or browser image paste instead.');
                setTimeout(() => setToastMessage(null), 2500);
              }
              return;
            }

            (async () => {
              if (disposed || !terminal) return;
              try {
                const result = await window.electronAPI.invoke(
                  'terminal:clipboard-paste-image',
                  sessionId || panel.sessionId
                ) as { filePath: string; imageNumber: number } | null;
                if (result?.filePath && !disposed && terminal) {
                  terminal.paste(`${result.filePath}\n`);
                  return;
                }
              } catch (err) {
                console.error('[TerminalPanel] Clipboard fallback failed:', err);
              }

              // No image found — forward the text content xterm would have pasted.
              if (text && !disposed && terminal) {
                pasteText(text);
              }
            })();
          };
          // Attach on the container in CAPTURE phase — fires before xterm's textarea
          // listener so we control whether an image or text is pasted.
          terminalRef.current.addEventListener('paste', handlePaste, { capture: true });

          // Handle drag-and-drop of files onto the terminal.
          //
          // Quirk: the old code only preventDefault'd when dataTransfer.types
          // contained exactly 'Files'. Chromium restricts access to types during
          // dragover on some platforms/versions, so that check could silently fail
          // mid-drag and the subsequent drop event would never reach us. We always
          // preventDefault on dragover now — harmless if the drop isn't a file,
          // and critical for letting the drop event fire when it is.
          const handleDragOver = (e: DragEvent) => {
            if (!e.dataTransfer) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          };
          const handleDrop = (e: DragEvent) => {
            e.preventDefault();
            if (!e.dataTransfer?.files.length || disposed || !terminal) return;

            // Save all dropped files to disk and paste the resolved path
            const files = Array.from(e.dataTransfer.files);
            (async () => {
              for (const file of files) {
                if (file.size > 50 * 1024 * 1024) {
                  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
                  if (!disposed && terminal) {
                    terminal.paste(`[Drop failed] File too large (${sizeMB} MB), max 50 MB\n`);
                  }
                  continue;
                }
                const dataUrl = await new Promise<string | null>((resolve) => {
                  const reader = new FileReader();
                  reader.onload = (ev) => resolve(ev.target?.result as string ?? null);
                  reader.onerror = () => resolve(null);
                  reader.readAsDataURL(file);
                });
                if (!dataUrl || disposed || !terminal) continue;
                try {
                  const isImage = file.type.startsWith('image/');
                  let resolvedPath: string | null = null;

                  if (isImage) {
                    const result = await window.electronAPI.invoke(
                      'terminal:paste-image',
                      panel.id,
                      sessionId || panel.sessionId,
                      dataUrl,
                      file.type
                    ) as { filePath: string; imageNumber: number } | null;
                    resolvedPath = result?.filePath ?? null;
                  } else {
                    const result = await window.electronAPI.invoke(
                      'terminal:paste-file',
                      sessionId || panel.sessionId,
                      dataUrl,
                      file.name
                    ) as { filePath: string } | null;
                    resolvedPath = result?.filePath ?? null;
                  }

                  if (resolvedPath && !disposed && terminal) {
                    // See paste-handler comment above: paste the raw path, Claude's
                    // parser detects image file paths and auto-attaches them.
                    terminal.paste(`${resolvedPath}\n`);
                  }
                } catch (err) {
                  console.error('[TerminalPanel] Failed to drop file:', err);
                  if (!disposed && terminal) {
                    // Strip Electron's IPC wrapper so the user sees the backend reason
                    const raw = err instanceof Error ? err.message : String(err);
                    const reason = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
                    terminal.paste(`[Drop failed] ${reason || 'Unknown error'}\n`);
                  }
                }
              }
            })();
          };
          terminalRef.current.addEventListener('dragover', handleDragOver);
          terminalRef.current.addEventListener('drop', handleDrop);

          // Let the WebGL renderer finish painting before removing the loader overlay.
          // Without this, the loader disappears and the user briefly sees stale/blank
          // content before the fit() render completes (visible as a stutter on macOS).
          await new Promise(resolve => setTimeout(resolve, 30));
          if (disposed) return;
          hotActivationEligibleRef.current = false;
          hotActivationPendingRef.current = false;
          setIsInitialized(true);
          console.log('[TerminalPanel] Terminal initialization complete, isInitialized set to true');

          // Core write-and-ack: consume a raw output chunk (already filtered by
          // source/panelId on the dispatcher side). Installed into a ref so the
          // `ptyId` effect below can swap subscription sources (legacy
          // `terminal:output` IPC vs `electronAPI.ptyHost.onData` port) without
          // re-running the full terminal init.
          const writeAndAck = (output: string) => {
            if (!terminal || disposed) return;
            const outputLength = output.length;
            terminal.write(output, () => {
              if (disposed) return;
              // Ack AFTER xterm has rendered the data — proper backpressure
              pendingAckBytes += outputLength;
              if (pendingAckBytes >= ACK_BATCH_SIZE) {
                flushAck();
              } else if (!ackFlushTimer) {
                ackFlushTimer = setTimeout(flushAck, ACK_BATCH_INTERVAL);
              }
              // Read scroll position LIVE after render, not before write —
              // avoids stale shouldSnap=true yanking user back to bottom
              if (isNearBottomRef.current && terminal) {
                terminal.scrollToBottom();
              }
            });
          };
          outputConsumerRef.current = { write: writeAndAck };

          // Legacy `terminal:output` IPC subscription. Stays the primary source
          // for flag-off panels (which never receive a `ptyId`). Under flag-on
          // main also tees bytes through the ptyHost MessagePort; to avoid
          // double-delivery to xterm, this handler short-circuits once the
          // panel's `ptyId` is populated and the dedicated effect below takes
          // over as the single byte source.
          const legacyOutputHandler = (data: unknown) => {
            if (currentPtyIdRef.current) return;
            if (data && typeof data === 'object' && 'panelId' in data && data.panelId && 'output' in data) {
              const typedData = data as { panelId: string; output: string };
              if (typedData.panelId === panel.id) {
                outputConsumerRef.current?.write(typedData.output);
              }
            }
            // Ignore session terminal output (has sessionId instead of panelId)
          };
          const unsubscribeOutput = window.electronAPI.events.onTerminalOutput(legacyOutputHandler);
          console.log('[TerminalPanel] Subscribed to terminal output events for panel:', panel.id);

          // Detect full-screen TUI apps (vim, htop, etc.) via alternate screen buffer.
          // This is universal — all well-behaved TUI apps enter alternate screen via
          // \x1b[?1049h and leave via \x1b[?1049l. No hardcoded app list needed.
          const unsubscribeAltScreen = window.electronAPI.events.onTerminalAlternateScreen((data: { panelId: string; active: boolean }) => {
            if (data.panelId === panel.id) {
              tuiActiveRef.current = data.active;
            }
          });

          // Initialize TUI mode for already-running programs (e.g. vim was
          // left open and the panel remounted).
          window.electronAPI.invoke('terminal:getAltScreenState', panel.id)
            .then((info: unknown) => {
              if (disposed || info == null || typeof info !== 'object') return;
              const { isAlternateScreen } = info as { isAlternateScreen: boolean };
              tuiActiveRef.current = isAlternateScreen;
            })
            .catch(() => { /* terminal may not exist yet — ignore */ });

          // Handle terminal process exit
          const unsubscribeExited = window.electronAPI.events.onTerminalExited((data: { sessionId: string; panelId: string; exitCode: number; signal: number | null }) => {
            if (data.panelId === panel.id) {
              // Reset TUI passthrough so Pane shortcuts work again on the dead terminal
              tuiActiveRef.current = false;
              if (terminal && !disposed) {
                // Detect crash signals: SIGABRT(6), SIGBUS(7), SIGSEGV(11)
                const crashSignals: Record<number, string> = { 6: 'SIGABRT', 7: 'SIGBUS', 11: 'SIGSEGV' };
                const crashSignalName = data.signal ? crashSignals[data.signal] : null;

                if (crashSignalName) {
                  terminal.write(`\r\n\x1b[91m[Process crashed: ${crashSignalName}]\x1b[0m\r\n`);
                  terminal.write(`\x1b[33m  Your system may be under memory pressure — check RAM usage.\x1b[0m\r\n`);
                } else {
                  terminal.write(`\r\n\x1b[90m[Process exited with code ${data.exitCode}]\x1b[0m\r\n`);
                }
              }
            }
          });

          // Subscribe to live terminal font updates from Settings
          const unsubscribeFontUpdate = window.electronAPI.events.onTerminalFontUpdated((data: { terminalFontFamily: string; terminalFontSize: number }) => {
            if (!terminal || disposed) return;
            const userFont = data.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
            const newFontFamily = buildTerminalFontFamily(userFont);
            const newFontSize = data.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE;
            if (terminal.options.fontFamily !== newFontFamily || terminal.options.fontSize !== newFontSize) {
              // Wait for the new font to load before applying, so xterm measures correct cell dimensions
              Promise.all([
                document.fonts.load(`${newFontSize}px "${userFont}"`).catch(() => {}),
                document.fonts.load(`${newFontSize}px "Symbols Nerd Font Mono"`).catch(() => {}),
              ]).then(() => {
                if (!terminal || disposed) return;
                terminal.options.fontFamily = newFontFamily;
                terminal.options.fontSize = newFontSize;
                // Hidden-container guard (see mount fit): defer to the activation fit
                if (fitAddon && (terminalRef.current?.getBoundingClientRect().width ?? 0) >= MIN_VIABLE_RECT_PX) {
                  fitAddon.fit();
                }
              });
            }
          });

          // Create interceptor for @ mentions and future trigger handlers
          const interceptor = new TerminalInterceptor({
            onStateChange: (state) => setInterceptorState(state.active ? state : null),
            onFlush: (data) => window.electronAPI.invoke('terminal:input', panel.id, data),
          });
          interceptorRef.current = interceptor;

          // Register @ handler for terminal scrollback copy
          const effectiveSessionId = sessionId || panel.sessionId;

          const getTerminals = async (): Promise<TerminalSuggestion[]> => {
            const allPanels = usePanelStore.getState().getSessionPanels(effectiveSessionId);
            const terminalPanels = allPanels.filter(p => p.type === 'terminal' && p.id !== panel.id);
            const suggestions = await Promise.all(terminalPanels.map(async (p) => {
              const resp = await window.electronAPI.invoke('terminal:getScrollbackClean', p.id, 20);
              let preview: string[] = ['(no output)'];
              if (resp?.success && resp.data?.content) {
                // Clean preview: filter blank lines, trim whitespace, take last 3
                preview = resp.data.content
                  .split('\n')
                  .map((l: string) => l.trim())
                  .filter((l: string) => l.length > 0)
                  .slice(-3);
                if (preview.length === 0) preview = ['(no output)'];
              }
              return { panelId: p.id, title: p.title, preview };
            }));
            return suggestions;
          };

          const handleCopy = async (targetPanelId: string, lines: number, mode: 'raw' | 'embed') => {
            try {
              if (mode === 'embed') {
                // Embed mode: save to file, insert path reference
                const response = await window.electronAPI.invoke(
                  'terminal:save-scrollback',
                  targetPanelId,
                  effectiveSessionId,
                  lines,
                );
                if (response?.success && response.data && terminal && !disposed) {
                  terminal.paste(response.data.filePath);
                  setToastMessage(`Embedded ${response.data.lineCount} lines from ${response.data.panelTitle}`);
                } else {
                  setToastMessage('Failed — no scrollback available');
                }
              } else {
                // Raw mode: paste clean text directly into terminal
                const response = await window.electronAPI.invoke(
                  'terminal:getScrollbackClean',
                  targetPanelId,
                  lines,
                );
                if (response?.success && response.data && terminal && !disposed) {
                  terminal.paste(response.data.content);
                  setToastMessage(`Pasted ${response.data.lineCount} lines from ${response.data.panelTitle}`);
                } else {
                  setToastMessage('Failed — no scrollback available');
                }
              }
            } catch {
              setToastMessage('Failed to paste scrollback');
            }
            setTimeout(() => setToastMessage(null), 2000);
          };

          interceptor.registerHandler('@', createAtTerminalHandler({
            sessionId: effectiveSessionId,
            currentPanelId: panel.id,
            getTerminals,
            hasOtherTerminals: () => {
              const allPanels = usePanelStore.getState().getSessionPanels(effectiveSessionId);
              return allPanels.filter(p => p.type === 'terminal' && p.id !== panel.id).length > 0;
            },
            onCopy: handleCopy,
            onStateChange: () => interceptor.notifyStateChange(),
            onForceCancel: () => interceptor.forceCancel(),
            getPreference: async (key: string) => {
              const resp = await window.electronAPI.invoke('preferences:get', key);
              return resp?.success ? (resp.data as string | null) : null;
            },
            setPreference: (key: string, value: string) => {
              window.electronAPI.invoke('preferences:set', key, value);
            },
          }));

          // Handle terminal input — route through interceptor first
          const inputDisposable = terminal.onData((data) => {
            // Skip interception for AltGr-produced @ (e.g. German keyboard)
            if (skipNextInterceptRef.current) {
              skipNextInterceptRef.current = false;
              window.electronAPI.invoke('terminal:input', panel.id, data);
              return;
            }
            const result = interceptor.handleInput(data);
            if (!result.consumed) {
              window.electronAPI.invoke('terminal:input', panel.id, data);
            }
          });

          // Handle resize — delegates to the guarded resizePtyToFit (single resize path)
          // Debounce so fit() only fires after transitions settle (300ms sidebar animations)
          let resizeTimer: ReturnType<typeof setTimeout> | null = null;
          const debouncedResize = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              if (!disposed) void resizePtyToFit();
            }, 150);
          };

          const resizeObserver = new ResizeObserver(() => {
            if (isActiveRef.current) {  // Only resize when panel is active
              debouncedResize();
            }
          });

          resizeObserver.observe(terminalRef.current);

          // FIX: Return comprehensive cleanup function
          const terminalElement = terminalRef.current;
          return () => {
            disposed = true;
            interceptor.dispose();
            interceptorRef.current = null;
            outputConsumerRef.current = null;
            flushAck();
            if (ackFlushTimer) clearTimeout(ackFlushTimer);
            resizeObserver.disconnect();
            if (resizeTimer) clearTimeout(resizeTimer);
            unsubscribeOutput();
            unsubscribeAltScreen();
            unsubscribeExited();
            unsubscribeFontUpdate();
            inputDisposable.dispose();
            scrollDisposable.dispose();
            terminalElement?.removeEventListener('paste', handlePaste, { capture: true });
            terminalElement?.removeEventListener('dragover', handleDragOver);
            terminalElement?.removeEventListener('drop', handleDrop);
          };
        }
      } catch (error) {
        console.error('Failed to initialize terminal:', error);
        setInitError(error instanceof Error ? error.message : 'Unknown error');
      }
    };

    const cleanupPromise = initializeTerminal();

    // Only dispose when component is actually unmounting (panel deleted)
    // Not when just switching tabs
    return () => {
      disposed = true;
      hotActivationEligibleRef.current = false;
      hotActivationPendingRef.current = false;

      // Synchronously push hidden cadence so backgrounded-session unmount
      // and unmount-during-init both reliably reach main. The inner cleanup
      // below is deferred via cleanupPromise.then(...) and may never run if
      // unmount happens before init resolves.
      window.electronAPI.invoke('terminal:setVisibility', panel.id, false, TERMINAL_VISIBILITY_VIEWER_ID);

      // Clean up async initialization
      cleanupPromise.then(cleanupFn => cleanupFn?.());

      // Dispose WebGL addon
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch { /* ignore */ }
        webglAddonRef.current = null;
      }

      // Dispose WebLinks addon
      if (webLinksAddonRef.current) {
        try { webLinksAddonRef.current.dispose(); } catch { /* ignore */ }
        webLinksAddonRef.current = null;
      }

      // Save serialized terminal snapshot before disposing
      if (serializeAddonRef.current && xtermRef.current) {
        try {
          const serialized = serializeAddonRef.current.serialize();
          window.electronAPI.invoke('terminal:saveSnapshot', panel.id, serialized);
        } catch (e) {
          console.warn('[TerminalPanel] Failed to save serialized snapshot:', e);
        }
      }

      // Dispose SerializeAddon
      if (serializeAddonRef.current) {
        try { serializeAddonRef.current.dispose(); } catch { /* ignore */ }
        serializeAddonRef.current = null;
      }

      // Dispose Unicode11Addon
      if (unicode11AddonRef.current) {
        try { unicode11AddonRef.current.dispose(); } catch { /* ignore */ }
        unicode11AddonRef.current = null;
      }

      // Dispose XTerm instance only on final unmount
      if (xtermRef.current) {
        try {
          console.log('[TerminalPanel] Disposing terminal for panel:', panel.id);
          xtermRef.current.dispose();
        } catch (e) {
          console.warn('Error disposing terminal:', e);
        }
        xtermRef.current = null;
      }
      
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.dispose();
        } catch (e) {
          console.warn('Error disposing fit addon:', e);
        }
        fitAddonRef.current = null;
      }
      
      setIsInitialized(false);
    };
  }, [panel.id]); // Only depend on panel.id to prevent re-initialization on session switch

  // Shared activation refresh for both power modes: fires on tab activation and
  // window refocus (activationVisible = panelVisible && windowFocused). Initial,
  // remounted, output-gated, and recovery activations stay on full reset+replay.
  // A same-session activation can use masked fit/reconcile/refresh only when this
  // exact mounted xterm previously completed the full path and output remained
  // ungated. Short performance-mode refocus stays a silent repaint. Declared
  // after WebGL policy effects so the delayed backstop covers re-attach races.
  useLayoutEffect(() => {
    if (!isInitialized || !fitAddonRef.current || !xtermRef.current) return;
    if (!activationVisible) {
      // Battery saver gates output and sustained blur separately invalidates the
      // mounted renderer. Panel hides may retain a hot-path candidate captured by
      // the WebGL policy effect when this exact xterm stayed live.
      if (useBatterySaverTerminalVisibility) {
        needsFullActivationRefreshRef.current = true;
        hotActivationEligibleRef.current = false;
        hotActivationPendingRef.current = false;
      }
      return;
    }

    // A hot activation is narrowly limited to panel hide/show in performance
    // mode after this mounted xterm previously completed a full refresh. Initial
    // construction, remounts, output gating, and recovery paths remain full.
    const hotActivation = !useBatterySaverTerminalVisibility
      && hotActivationPendingRef.current
      && hotActivationEligibleRef.current;
    hotActivationPendingRef.current = false;
    const fullRefresh = !hotActivation && (useBatterySaverTerminalVisibility || needsFullActivationRefreshRef.current);

    // Both full and hot panel activations stay behind the existing opaque mask.
    if (fullRefresh || hotActivation) setIsRefreshing(true);

    let lastWidth = 0;
    let retries = 0;
    const MAX_RETRIES = 10;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let delayedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null;

    const fitAndRefresh = () => {
      if (cancelled || !fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;

      const containerWidth = terminalRef.current.clientWidth;
      // If width is still changing or below viable threshold, the reflow isn't done — retry
      if ((containerWidth < MIN_VIABLE_RECT_PX || containerWidth !== lastWidth) && retries < MAX_RETRIES) {
        lastWidth = containerWidth;
        retries++;
        retryTimer = setTimeout(fitAndRefresh, 50);
        return;
      }

      // Never settled at a viable size — bail; the ResizeObserver finishes the job
      // once layout settles. Leave the ref armed so the next activation retries full.
      if (containerWidth < MIN_VIABLE_RECT_PX) {
        forwardToMainLog('warn', `[TerminalPanel] Activation refresh bailed for panel ${panel.id}: container ${containerWidth}px`);
        setIsRefreshing(false);
        if (autoFocus && fullRefresh) xtermRef.current?.focus();
        return;
      }

      void document.fonts.ready.then(async () => {
        if (cancelled || !fitAddonRef.current || !xtermRef.current) return;

        if (fullRefresh) {
          // Consume the flag only when the full refresh actually executes, so a
          // bail or an activate-then-blur cancellation leaves it armed.
          needsFullActivationRefreshRef.current = false;
          await handleRefreshTerminal();
          hotActivationEligibleRef.current = !useBatterySaverTerminalVisibility;
        } else if (hotActivation) {
          await reconcileMountedTerminal();
        } else {
          repaintTerminal();
        }
        await waitForNextPaint();
        if (cancelled) return;

        if (autoFocus && (fullRefresh || hotActivation)) {
          xtermRef.current?.focus();
        }

        delayedRefreshTimer = setTimeout(() => {
          void (async () => {
            if (cancelled || !fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;
            forwardToMainLog('info', `[TerminalPanel] Delayed activation refresh for panel ${panel.id}`);
            if (fullRefresh) await handleRefreshTerminal();
            else if (hotActivation) await reconcileMountedTerminal();
            else repaintTerminal();
            if (!hotActivation) return;
            await waitForNextPaint();
            if (cancelled) return;
            hideOverlayTimer = setTimeout(() => {
              if (!cancelled) setIsRefreshing(false);
            }, TERMINAL_ACTIVATION_MASK_AFTER_PAINT_MS);
          })();
        }, REFOCUS_DELAYED_REFRESH_MS);

        if (fullRefresh) {
          // Full refresh keeps the historical mask timing. Hot activation keeps
          // the mask through its delayed fit/reconcile/refresh backstop above.
          hideOverlayTimer = setTimeout(() => {
            if (!cancelled) setIsRefreshing(false);
          }, TERMINAL_ACTIVATION_MASK_AFTER_PAINT_MS);
        }
      });
    };

    const animationFrame = requestAnimationFrame(fitAndRefresh);

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      if (retryTimer) clearTimeout(retryTimer);
      if (delayedRefreshTimer) clearTimeout(delayedRefreshTimer);
      if (hideOverlayTimer) clearTimeout(hideOverlayTimer);
      setIsRefreshing(false);
    };
  }, [activationVisible, panelVisible, useBatterySaverTerminalVisibility, panel.id, isInitialized, autoFocus, handleRefreshTerminal, reconcileMountedTerminal, repaintTerminal, forwardToMainLog]);

  useEffect(() => {
    if (!xtermRef.current) {
      return;
    }
    const newTheme = getTerminalTheme();
    xtermRef.current.options.theme = newTheme;
    xtermRef.current.options.minimumContrastRatio =
      document.documentElement.classList.contains('light') ? 4.5 : 1;
    const rows = xtermRef.current.rows;
    if (rows > 0) {
      xtermRef.current.refresh(0, rows - 1);
      // After refresh, restore scroll to bottom to prevent flicker-to-top
      xtermRef.current.scrollToBottom();
    }
  }, [theme]);


  // Handle missing session context (show after all hooks have been called)
  if (!sessionContext) {
    return (
      <div className="flex items-center justify-center h-full text-red-500">
        Pane context not available
      </div>
    );
  }

  if (initError) {
    return (
      <div className="flex items-center justify-center h-full text-red-500">
        Terminal initialization failed: {initError}
      </div>
    );
  }

  // Always render the terminal div to keep XTerm instance alive
  return (
    <div className="h-full w-full relative group/terminal" onMouseMove={onMouseMove} onKeyDown={handleTerminalKeyDown}>
      <div ref={terminalRef} className="h-full w-full" />

      {/* Terminal search overlay */}
      <TerminalSearchOverlay
        isOpen={isSearchOpen}
        searchQuery={searchQuery}
        searchStatus={searchStatus}
        searchInputRef={searchInputRef}
        onQueryChange={onQueryChange}
        onStep={onStep}
        onClose={closeSearch}
      />

      {/* Terminal scroll buttons — compact, revealed on hover */}
      {isInitialized && (
        <div className="absolute top-2 right-5 z-30 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover/terminal:opacity-100 group-hover/terminal:pointer-events-auto transition-opacity">
          <button
            onClick={() => { void handleManualRefresh(); }}
            className="p-0.5 rounded bg-surface-secondary/60 hover:bg-surface-tertiary/80 text-text-tertiary hover:text-text-secondary transition-colors"
            title="Refresh terminal"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 2v3h3" />
              <path d="M10.5 10v-3h-3" />
              <path d="M9.25 4.5A3.75 3.75 0 0 0 3 3.15L1.5 5" />
              <path d="M2.75 7.5A3.75 3.75 0 0 0 9 8.85L10.5 7" />
            </svg>
          </button>
          <button
            onClick={() => xtermRef.current?.scrollToTop()}
            className="p-0.5 rounded bg-surface-secondary/60 hover:bg-surface-tertiary/80 text-text-tertiary hover:text-text-secondary transition-colors"
            title="Scroll to top"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7L6 4L9 7" />
            </svg>
          </button>
          <button
            onClick={() => {
              xtermRef.current?.scrollToBottom();
              isNearBottomRef.current = true;
            }}
            className="p-0.5 rounded bg-surface-secondary/60 hover:bg-surface-tertiary/80 text-text-tertiary hover:text-text-secondary transition-colors"
            title="Scroll to bottom"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 5L6 8L9 5" />
            </svg>
          </button>
        </div>
      )}

      {/* Jump-to-bottom pill — appears when scrolled up */}
      {showScrollDown && isInitialized && (
        <button
          onClick={() => {
            xtermRef.current?.scrollToBottom();
            isNearBottomRef.current = true;
            setShowScrollDown(false);
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center justify-center w-7 h-7 rounded-full bg-[color-mix(in_srgb,var(--color-text-primary)_6%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] text-text-tertiary hover:text-text-secondary transition-colors duration-150"
          title="Jump to bottom"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6L7 9L10 6" />
          </svg>
        </button>
      )}

      {(!isInitialized || isRefreshing || (isCliPanel && !isCliReady)) && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-primary z-10">
          <div className="flex flex-col items-center gap-3">
            <TerminalSpinner />
            <div className="text-text-secondary text-sm">
              {!isInitialized ? 'Initializing terminal...' : isRefreshing ? 'Refreshing terminal...' : 'Starting CLI...'}
            </div>
          </div>
        </div>
      )}

      {/* Terminal link overlays */}
      <TerminalLinkTooltip
        visible={tooltip.visible}
        x={tooltip.x}
        y={tooltip.y}
        linkText={tooltip.text}
        hint={tooltip.hint}
      />

      <TerminalPopover
        visible={filePopover.visible}
        x={filePopover.x}
        y={filePopover.y}
        onClose={closeFilePopover}
      >
        <PopoverButton onClick={handleOpenInEditor}>
          <span className="flex items-center gap-2">
            <FileEdit className="w-4 h-4" />
            Open in Editor
          </span>
        </PopoverButton>
        <PopoverButton
          onClick={handleShowInExplorer}
          disabled={isRemoteMode}
          title={isRemoteMode ? 'Only available in local mode' : undefined}
        >
          <span className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Show in Explorer{isRemoteMode ? ' (local only)' : ''}
          </span>
        </PopoverButton>
      </TerminalPopover>

      <SelectionPopover
        visible={selectionPopover.visible}
        x={selectionPopover.x}
        y={selectionPopover.y}
        text={selectionPopover.text}
        workingDirectory={workingDirectory}
        sessionId={panel.sessionId}
        isRemoteMode={isRemoteMode}
        onOpenInBrowser={handleOpenInBrowser}
        onClose={closeSelectionPopover}
      />

      {/* Terminal interceptor overlays */}
      {interceptorState && (
        <InterceptorDropdown
          visible={interceptorState.active}
          terminals={(interceptorState.handlerState as AtTerminalHandlerState).terminals}
          selectedIndex={(interceptorState.handlerState as AtTerminalHandlerState).selectedIndex}
          lineCountPresetIndex={(interceptorState.handlerState as AtTerminalHandlerState).lineCountPresetIndex}
          pasteMode={(interceptorState.handlerState as AtTerminalHandlerState).pasteMode}
          filterText={interceptorState.buffer}
          position={getDropdownPosition()}
        />
      )}
      {toastMessage && (
        <InterceptorToast
          visible={!!toastMessage}
          message={toastMessage}
          onHide={() => setToastMessage(null)}
        />
      )}
    </div>
  );
});

TerminalPanel.displayName = 'TerminalPanel';

export default TerminalPanel;
