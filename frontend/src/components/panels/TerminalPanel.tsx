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

export const TerminalPanel: React.FC<TerminalPanelProps> = React.memo(({ panel, isActive }) => {
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
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

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
          await window.electronAPI.invoke('panels:initialize', panel.id, {
            cwd: workingDirectory || process.cwd(),
            sessionId: sessionId || panel.sessionId
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
            } else if (dist > prevDistFromBottom) {
              // User scrolled UP — they want to read history, disable sticky
              isNearBottomRef.current = false;
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
          const ACK_HEARTBEAT_INTERVAL = 500; // ms - safety heartbeat to flush any pending acks
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

          // Heartbeat: periodically flush any pending acks as a safety net
          const heartbeatInterval = setInterval(flushAck, ACK_HEARTBEAT_INTERVAL);

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
          // XTerm.js in Electron doesn't handle clipboard paste natively, so we
          // intercept the paste event and feed it to the terminal explicitly
          const handlePaste = (e: ClipboardEvent) => {
            // Check for images in browser clipboard first (works on native Windows/macOS)
            const items = e.clipboardData?.items;
            let foundBrowserImage = false;
            if (items) {
              for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/')) {
                  foundBrowserImage = true;
                  e.preventDefault();
                  const file = items[i].getAsFile();
                  if (!file) return;

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
                      const result = await window.electronAPI.invoke(
                        'terminal:paste-image',
                        panel.id,
                        sessionId || panel.sessionId,
                        dataUrl,
                        file.type
                      ) as { filePath: string; imageNumber: number } | null;
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

            if (!foundBrowserImage) {
              // No image in browser clipboard — try system clipboard fallback
              // (handles WSL, some Linux configs where browser doesn't see images)
              const text = e.clipboardData?.getData('text');

              // Only attempt fallback if there's no text being pasted,
              // or if text is empty (user likely intended to paste an image)
              if (!text) {
                e.preventDefault();
                (async () => {
                  if (disposed || !terminal) return;
                  try {
                    const result = await window.electronAPI.invoke(
                      'terminal:clipboard-paste-image',
                      sessionId || panel.sessionId
                    ) as { filePath: string; imageNumber: number } | null;
                    if (result?.filePath && !disposed && terminal) {
                      terminal.paste(`[Image] ${result.filePath}\n`);
                    }
                  } catch (err) {
                    console.error('[TerminalPanel] Clipboard fallback failed:', err);
                  }
                })();
                return;
              }

              // Regular text paste — let xterm's built-in paste handler
              // process it (it already listens for paste on its textarea).
              // Calling terminal.paste() here would double-inject the text.
            }
          };
          // Attach paste handler to xterm's internal textarea — xterm calls
          // stopPropagation() on paste events so they never bubble to the container.
          // On Windows this means a container-level listener never fires.
          const xtermTextarea = terminalRef.current.querySelector('textarea.xterm-helper-textarea');
          if (xtermTextarea) {
            xtermTextarea.addEventListener('paste', handlePaste as EventListener);
          } else {
            terminalRef.current.addEventListener('paste', handlePaste);
          }

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
                // FIX: Send ack IMMEDIATELY when data is received, not when write completes
                // This prevents PTY from pausing when XTerm is overwhelmed by high-frequency TUI updates
                pendingAckBytes += typedData.output.length;
                if (pendingAckBytes >= ACK_BATCH_SIZE) {
                  flushAck();
                } else if (!ackFlushTimer) {
                  ackFlushTimer = setTimeout(flushAck, ACK_BATCH_INTERVAL);
                }

                // Write to terminal — if user is near bottom, snap back after write
                // completes to prevent the viewport jumping to top on large output chunks
                const shouldSnap = isNearBottomRef.current;
                terminal.write(typedData.output, () => {
                  if (shouldSnap && terminal && !disposed) {
                    terminal.scrollToBottom();
                  }
                });
              }
            }
            // Ignore session terminal output (has sessionId instead of panelId)
          };

          const unsubscribeOutput = window.electronAPI.events.onTerminalOutput(outputHandler);
          console.log('[TerminalPanel] Subscribed to terminal output events for panel:', panel.id);

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

          // Handle terminal input
          const inputDisposable = terminal.onData((data) => {
            window.electronAPI.invoke('terminal:input', panel.id, data);
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
            clearInterval(heartbeatInterval);
            clearInterval(snapshotInterval);
            flushAck();
            if (ackFlushTimer) clearTimeout(ackFlushTimer);
            resizeObserver.disconnect();
            if (resizeTimer) clearTimeout(resizeTimer);
            unsubscribeOutput();
            unsubscribeFontUpdate();
            inputDisposable.dispose();
            scrollDisposable.dispose();
            terminalElement?.removeEventListener('paste', handlePaste);
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

  // Handle visibility changes (resize and focus when becoming visible)
  // Include isInitialized so this effect re-runs after terminal initialization completes
  useEffect(() => {
    if (isActive && isInitialized && fitAddonRef.current && xtermRef.current) {
      // After display:none→block, the container needs time to reflow to its final size.
      // We fit repeatedly until the width stabilizes, then do a final repaint + focus.
      let lastWidth = 0;
      let retries = 0;
      const MAX_RETRIES = 10;

      const fitTerminal = () => {
        if (!fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;

        const containerWidth = terminalRef.current.clientWidth;

        // If width is still changing or zero, the reflow isn't done — retry
        if ((containerWidth === 0 || containerWidth !== lastWidth) && retries < MAX_RETRIES) {
          lastWidth = containerWidth;
          retries++;
          setTimeout(fitTerminal, 50);
          return;
        }

        fitAddonRef.current.fit();
        const dimensions = fitAddonRef.current.proposeDimensions();
        if (dimensions) {
          window.electronAPI.invoke('terminal:resize', panel.id, dimensions.cols, dimensions.rows);
        }

        // Repaint all visible rows — after display:none→block, the WebGL/canvas
        // renderer has stale glyph positions that cause janky shifted text.
        const rows = xtermRef.current?.rows ?? 0;
        if (rows > 0) {
          xtermRef.current!.refresh(0, rows - 1);
        }
        xtermRef.current?.focus();
      };

      requestAnimationFrame(fitTerminal);
    }
  }, [isActive, panel.id, isInitialized]);

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

      {(!isInitialized || (isCliPanel && !isCliReady)) && (
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
        onClose={closeSelectionPopover}
      />
    </div>
  );
});

TerminalPanel.displayName = 'TerminalPanel';

export default TerminalPanel;
