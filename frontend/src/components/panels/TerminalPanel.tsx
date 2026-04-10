import React, { useRef, useEffect, useState, useCallback } from 'react';
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
import { FileEdit, FolderOpen } from 'lucide-react';
import { useTerminalLinks } from '../terminal/hooks/useTerminalLinks';
import { TerminalLinkTooltip } from '../terminal/TerminalLinkTooltip';
import { TerminalPopover, PopoverButton } from '../terminal/TerminalPopover';
import { SelectionPopover } from '../terminal/SelectionPopover';
import { useTerminalSearch } from '../../hooks/useTerminalSearch';
import { TerminalSearchOverlay } from '../terminal/TerminalSearchOverlay';
import type { TerminalPanelState } from '../../../../shared/types/panels';
import { TerminalInterceptor } from '../../services/terminalInterceptor/TerminalInterceptor';
import { createAtTerminalHandler } from '../../services/terminalInterceptor/handlers/atTerminalHandler';
import { InterceptorDropdown } from '../terminal/InterceptorDropdown';
import { InterceptorToast } from '../terminal/InterceptorToast';
import { usePanelStore } from '../../stores/panelStore';
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
  serializedBuffer?: string;
  cursorX?: number;
  cursorY?: number;
}

const DEFAULT_TERMINAL_FONT_FAMILY = 'Geist Mono';
const DEFAULT_TERMINAL_FONT_SIZE = 14;

function buildTerminalFontFamily(userFont: string): string {
  return `"${userFont}", "Symbols Nerd Font Mono", monospace`;
}

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
  const interceptorRef = useRef<TerminalInterceptor | null>(null);
  const skipNextInterceptRef = useRef(false); // set by AltGr @ detection

  // Read CLI state from persisted panel state (handles remount case)
  const terminalState = panel.state?.customState as TerminalPanelState | undefined;
  const isCliPanel = !!terminalState?.isCliPanel;
  const [isCliReady, setIsCliReady] = useState(!!terminalState?.isCliReady);

  // Sync isCliReady from panel prop when it changes (e.g. backend persisted isCliReady
  // before this component subscribed to the IPC event, or panel state was updated externally)
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
    isActiveRef.current = isActive;
  }, [isActive]);

  // Terminal link handling hook
  const {
    onMouseMove,
    tooltip,
    filePopover,
    selectionPopover,
    handleOpenInEditor,
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

  // Refresh terminal: reset and rewrite fresh scrollback from backend
  const handleRefreshTerminal = useCallback(async () => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    try {
      const state = await window.electronAPI.invoke('terminal:getState', panel.id);
      terminal.reset();
      if (state?.scrollbackBuffer) {
        const content = typeof state.scrollbackBuffer === 'string'
          ? state.scrollbackBuffer
          : Array.isArray(state.scrollbackBuffer)
            ? state.scrollbackBuffer.join('\n')
            : '';
        if (content) terminal.write(content);
      }
      fitAddonRef.current?.fit();
    } catch (e) {
      console.warn('[TerminalPanel] Failed to refresh terminal:', e);
    }
  }, [panel.id]);

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
          if (terminalState && (terminalState.scrollbackBuffer || terminalState.serializedBuffer)) {
            // We'll restore this to the terminal after it's created
            console.log('[TerminalPanel] Found restore state — scrollback:', !!terminalState.scrollbackBuffer, 'serialized:', !!terminalState.serializedBuffer);
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
          minimumContrastRatio: 1,
          macOptionIsMeta: false,
        });
        console.log('[TerminalPanel] XTerm instance created:', !!terminal);

        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        console.log('[TerminalPanel] FitAddon loaded');

        // Intercept app-level shortcuts before xterm consumes them
        terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          // When a TUI app is running, pass most keys through to the PTY
          // but still let Ctrl/Cmd+V use the browser's native paste path
          if (tuiActiveRef.current) {
            const cm = e.ctrlKey || e.metaKey;
            if (cm && e.key.toLowerCase() === 'v') return false;
            return true;
          }

          // Shift+Enter: emit the same sequence as Alt+Enter (\x1b\r = ESC+CR)
          // xterm.js ignores shiftKey on Enter, so Shift+Enter = Enter by default.
          // Alt+Enter natively sends \x1b\r which CLI tools recognize as "insert newline".
          // Block both keydown and keyup to fully suppress xterm's default \r.
          if (e.shiftKey && e.key === 'Enter') {
            if (e.type === 'keydown') {
              window.electronAPI.invoke('terminal:input', panel.id, '\x1b\r');
            }
            return false;
          }

          const ctrlOrMeta = e.ctrlKey || e.metaKey;

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
          if (ctrlOrMeta && e.altKey && e.key === '/') return false;
          // Ctrl/Cmd+W or Ctrl/Cmd+Q: close active tab
          if (ctrlOrMeta && (e.key.toLowerCase() === 'w' || e.key.toLowerCase() === 'q')) return false;
          // Ctrl/Cmd+T: open Add Tool dropdown
          if (ctrlOrMeta && e.key.toLowerCase() === 't') return false;
          // Ctrl/Cmd+K: command palette
          if (ctrlOrMeta && e.key.toLowerCase() === 'k') return false;
          // Ctrl/Cmd+P: prompt history
          if (ctrlOrMeta && e.key.toLowerCase() === 'p') return false;
          // Ctrl/Cmd+N: new workspace
          if (ctrlOrMeta && e.key.toLowerCase() === 'n') return false;
          // Ctrl/Cmd+Shift+D: toggle diff
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'd') return false;
          // Ctrl/Cmd+Shift+R: toggle run
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'r') return false;
          // Git shortcuts - release to DOM for hotkeyStore
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'm') return false;
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'p') return false;
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
          fitAddon.fit();
          console.log('[TerminalPanel] FitAddon fitted');
          terminal.options.theme = getTerminalTheme();

          // Try loading WebGL renderer for GPU-accelerated rendering
          try {
            const { WebglAddon: WebglAddonImpl } = await import('@xterm/addon-webgl');
            if (!disposed) {
              const addon = new WebglAddonImpl();
              addon.onContextLoss(() => {
                console.warn('[TerminalPanel] WebGL context lost for panel', panel.id, ', falling back to DOM renderer');
                try { addon.dispose(); } catch { /* already disposed */ }
                webglAddonRef.current = null;
              });
              terminal.loadAddon(addon);
              webglAddonRef.current = addon;
              console.log('[TerminalPanel] WebGL renderer loaded for panel', panel.id);
            }
          } catch (e) {
            console.warn('[TerminalPanel] WebGL renderer failed for panel', panel.id, ', using DOM renderer:', e);
            webglAddonRef.current = null;
          }

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
          const SNAP_THRESHOLD = 3; // lines — for the "can't reach input" snap fix
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
          const ACK_BATCH_SIZE = 10_000; // 10KB
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
              window.electronAPI.invoke('terminal:ack', panel.id, bytes);
            }
          };

          // Periodically save serialized snapshot so it's available on app quit
          // (main process can't call SerializeAddon — only the renderer can)
          const SNAPSHOT_INTERVAL = 30_000; // 30 seconds
          const snapshotInterval = setInterval(() => {
            if (serializeAddonRef.current && terminal && !disposed) {
              try {
                const serialized = serializeAddonRef.current.serialize();
                window.electronAPI.invoke('terminal:saveSnapshot', panel.id, serialized);
              } catch {
                // Serialization can fail if terminal is in a bad state — ignore
              }
            }
          }, SNAPSHOT_INTERVAL);

          // Restore scrollback if we have saved state FOR THIS PANEL
          // When the PTY is alive (initialized === true), always prefer raw scrollback
          // because it accumulates all PTY output in real-time — the serialized snapshot
          // is frozen at the moment the component last unmounted and misses any output
          // that arrived while the panel wasn't displayed.
          // The serialized snapshot is only more valuable for app restart scenarios
          // (PTY gone, raw buffer lost) where it preserves formatting.
          if (terminalStateForThisPanel) {
            // Raw scrollback: always current when PTY is alive, contains full ANSI codes
            if (terminalStateForThisPanel.scrollbackBuffer) {
              let restoredContent: string;
              if (typeof terminalStateForThisPanel.scrollbackBuffer === 'string') {
                restoredContent = terminalStateForThisPanel.scrollbackBuffer;
                console.log('[TerminalPanel] Restoring', restoredContent.length, 'chars of scrollback (raw, live PTY)');
              } else if (Array.isArray(terminalStateForThisPanel.scrollbackBuffer)) {
                restoredContent = terminalStateForThisPanel.scrollbackBuffer.join('\n');
                console.log('[TerminalPanel] Restoring', terminalStateForThisPanel.scrollbackBuffer.length, 'lines of scrollback (raw, live PTY)');
              } else {
                restoredContent = '';
              }
              if (restoredContent) {
                terminal.write(restoredContent);
              }
            } else if (terminalStateForThisPanel.serializedBuffer) {
              // Fallback: serialized snapshot (for when raw scrollback is empty/unavailable)
              console.log('[TerminalPanel] Restoring serialized snapshot for panel', panel.id);
              terminal.write(terminalStateForThisPanel.serializedBuffer);
            }
            // Force WebGL renderer to redraw after buffer content changes.
            // Without this, macOS WebGL canvas shows stale/stuttered content until
            // a resize event (minimize/fullscreen) forces invalidation.
            fitAddon.fit();
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
          // PASTE-DBG: fire-and-forget IPC to write a debug line to ~/.pane/logs/paste-dbg.log.
          // console.warn in the renderer only shows in DevTools; this file is readable from disk.
          const dbg = (msg: string) => {
            try { window.electronAPI.invoke('terminal:paste-dbg', msg); } catch { /* ignore */ }
          };
          const handlePaste = (e: ClipboardEvent) => {
            // Step 1: Check for images in browser clipboard (works on native Windows/macOS)
            const items = e.clipboardData?.items;
            const allItemTypes = items ? Array.from({ length: items.length }, (_, i) => `${items[i].kind}:${items[i].type}`) : [];
            const textVal = e.clipboardData?.getData('text') ?? '';
            dbg(`capture fired — items:${JSON.stringify(allItemTypes)} text:${JSON.stringify(textVal.slice(0, 60))} phase:${e.eventPhase}`);
            if (items) {
              for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/')) {
                  dbg(`Step1: browser image found, type:${items[i].type}`);
                  e.stopPropagation();
                  e.preventDefault();
                  const file = items[i].getAsFile();
                  if (!file) { dbg('Step1: getAsFile() returned null — bailing'); return; }

                  if (file.size > 10 * 1024 * 1024) {
                    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
                    if (terminal && !disposed) {
                      terminal.paste(`[Image paste failed] File too large (${sizeMB} MB), max 10 MB\n`);
                    }
                    return;
                  }

                  const reader = new FileReader();
                  reader.onload = async (ev) => {
                    if (disposed || !terminal) return;
                    const dataUrl = ev.target?.result as string;
                    if (!dataUrl) return;

                    try {
                      dbg('Step1: calling terminal:paste-image IPC');
                      const result = await window.electronAPI.invoke(
                        'terminal:paste-image',
                        panel.id,
                        sessionId || panel.sessionId,
                        dataUrl,
                        file.type
                      ) as { filePath: string; imageNumber: number } | null;
                      dbg(`Step1: terminal:paste-image result:${JSON.stringify(result)}`);
                      if (result?.filePath && !disposed && terminal) {
                        terminal.paste(`[Image] ${result.filePath}\n`);
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
            dbg(`Step2: no browser image — blocking xterm, calling Electron clipboard IPC. text was:${JSON.stringify(text.slice(0, 60))}`);
            e.stopPropagation();
            e.preventDefault();

            (async () => {
              if (disposed || !terminal) return;
              try {
                const result = await window.electronAPI.invoke(
                  'terminal:clipboard-paste-image',
                  sessionId || panel.sessionId
                ) as { filePath: string; imageNumber: number } | null;
                dbg(`Step2: terminal:clipboard-paste-image result:${JSON.stringify(result)}`);
                if (result?.filePath && !disposed && terminal) {
                  terminal.paste(`[Image] ${result.filePath}\n`);
                  return;
                }
              } catch (err) {
                dbg(`Step2: clipboard IPC threw: ${String(err)}`);
                console.error('[TerminalPanel] Clipboard fallback failed:', err);
              }

              // No image found — forward the text content xterm would have pasted.
              dbg(`Step2: no image from Electron clipboard, forwarding text:${JSON.stringify(text.slice(0, 60))}`);
              if (text && !disposed && terminal) {
                terminal.paste(text);
              }
            })();
          };
          // Attach on the container in CAPTURE phase — fires before xterm's textarea
          // listener so we control whether an image or text is pasted.
          terminalRef.current.addEventListener('paste', handlePaste, { capture: true });

          // Handle drag-and-drop of files onto the terminal
          const handleDragOver = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            }
          };
          const handleDrop = (e: DragEvent) => {
            if (!e.dataTransfer?.files.length || disposed || !terminal) return;
            e.preventDefault();

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
                    const prefix = isImage ? '[Image] ' : '';
                    terminal.paste(`${prefix}${resolvedPath}\n`);
                  }
                } catch (err) {
                  console.error('[TerminalPanel] Failed to drop file:', err);
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
          setIsInitialized(true);
          console.log('[TerminalPanel] Terminal initialization complete, isInitialized set to true');

          // Set up IPC communication for terminal I/O
          const outputHandler = (data: { panelId?: string; sessionId?: string; output?: string } | unknown) => {
            // Check if this is panel terminal output (has panelId) vs session terminal output (has sessionId)
            if (data && typeof data === 'object' && 'panelId' in data && data.panelId && 'output' in data) {
              const typedData = data as { panelId: string; output: string };
              if (typedData.panelId === panel.id && terminal && !disposed) {
                const outputLength = typedData.output.length;
                terminal.write(typedData.output, () => {
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
              }
            }
            // Ignore session terminal output (has sessionId instead of panelId)
          };

          const unsubscribeOutput = window.electronAPI.events.onTerminalOutput(outputHandler);
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
                if (fitAddon) fitAddon.fit();
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

          // Handle resize
          // Debounce resize so fit() only fires after transitions settle (300ms sidebar animations)
          let resizeTimer: ReturnType<typeof setTimeout> | null = null;
          const debouncedResize = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              if (fitAddon && !disposed && terminalRef.current) {
                // Skip resize if container is too small (likely hidden via display:none or mid-collapse)
                const rect = terminalRef.current.getBoundingClientRect();
                if (rect.width < 100 || rect.height < 100) {
                  return;
                }

                fitAddon.fit();
                const dimensions = fitAddon.proposeDimensions();
                if (dimensions) {
                  window.electronAPI.invoke('terminal:resize', panel.id, dimensions.cols, dimensions.rows);
                }
              }
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
            clearInterval(snapshotInterval);
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

  // Handle visibility changes (resize and full refresh when becoming visible)
  // Include isInitialized so this effect re-runs after terminal initialization completes
  useEffect(() => {
    if (!isActive || !isInitialized || !fitAddonRef.current || !xtermRef.current) return;

    // Show overlay immediately to mask the terminal.reset()+rewrite flicker
    setIsRefreshing(true);

    let lastWidth = 0;
    let retries = 0;
    const MAX_RETRIES = 10;

    const fitAndRefresh = async () => {
      if (!fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;

      const containerWidth = terminalRef.current.clientWidth;

      // If width is still changing or zero, the reflow isn't done — retry
      if ((containerWidth === 0 || containerWidth !== lastWidth) && retries < MAX_RETRIES) {
        lastWidth = containerWidth;
        retries++;
        setTimeout(fitAndRefresh, 50);
        return;
      }

      // Container stable — full refresh (reset + rewrite scrollback + fit)
      // This is what the manual "Refresh terminal" button does and makes TUI apps repaint correctly
      await handleRefreshTerminal();

      if (autoFocus) {
        xtermRef.current?.focus();
      }

      // Hide overlay 100ms after refresh resolves to ensure content is painted
      setTimeout(() => setIsRefreshing(false), 100);
    };

    requestAnimationFrame(fitAndRefresh);
  }, [isActive, panel.id, isInitialized, autoFocus, handleRefreshTerminal]);

  useEffect(() => {
    if (!xtermRef.current) {
      return;
    }
    const newTheme = getTerminalTheme();
    xtermRef.current.options.theme = newTheme;
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
        <div className="absolute -top-0.5 right-2 z-30 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover/terminal:opacity-100 group-hover/terminal:pointer-events-auto transition-opacity">
          <button
            onClick={handleRefreshTerminal}
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
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center justify-center w-7 h-7 rounded-full text-text-tertiary hover:text-text-secondary transition-colors duration-150"
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
              {!isInitialized ? 'Initializing terminal...' : 'Starting CLI...'}
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
        <PopoverButton onClick={handleShowInExplorer}>
          <span className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Show in Explorer
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
