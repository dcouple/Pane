import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCommittedRef } from './useCommittedRef';
import { Terminal, type IDisposable } from '@xterm/xterm';
import {
  getTerminalTheme,
  buildTerminalFontFamily,
  getMinimumContrastRatio,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from '../utils/terminalTheme';
import { useConfigStore } from '../stores/configStore';
import { useTheme } from '../contexts/ThemeContext';
import { MISSION_CONTROL_VIEWER_PREFIX } from '../../../shared/types/missionControl';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { TerminalOutputEvent } from '../../../shared/types/panels';
import { terminalOutputByteLength } from '../utils/terminalRestore';

/**
 * Read-only xterm for a Mission Control tile.
 *
 * A tile is roughly a fifth of the width the real terminal panel gets, so the
 * whole job is fitting a wide PTY into a small box without lying about it.
 * Four rules, each learned the hard way:
 *
 * 1. **Render exactly the PTY's columns — never fewer, never more.** Agent TUIs
 *    paint with absolute cursor positioning sized to the real PTY. A narrower
 *    viewer wraps every line and each repaint pushes the viewport down, so the
 *    console scrolls forever. A *wider* one is just as wrong in the other
 *    direction: lines that wrapped in the PTY arrive unwrapped, every later
 *    partial redraw lands a row off, and the tile fills with text painted over
 *    text. Matching exactly is the only correct width; what does not fit the
 *    tile is clipped, and `clippedRight` says so.
 * 2. **Height depends on which buffer the agent uses.** On the alternate
 *    screen the frame *is* the PTY's height and its bottom rows carry the
 *    prompt, so the terminal must be that tall and anchored to the bottom. In
 *    the normal buffer output simply scrolls, the tail is what matters, and a
 *    full-height grid would leave the visible bottom rows blank — which is
 *    exactly why Codex tiles rendered empty.
 * 3. **Fit by font size, not by scaling.** `transform: scale()` on a 120-column
 *    terminal in a 400px tile yields a ~4px glyph. Choosing a font size so the
 *    PTY's columns fit — clamped to a readable floor — shows far more and stays
 *    legible.
 * 4. **A tile must never answer the agent's terminal queries.** It is a second
 *    view of a PTY the real panel already answers for; see
 *    `suppressTerminalReplies`.
 *
 * Also unlike `TerminalPanel`: no `WebglAddon` (instances sharing a font+theme
 * share a texture atlas, and Chromium caps live GL contexts at ~16), no
 * `FitAddon`, `disableStdin`, and a `MISSION_CONTROL_VIEWER_PREFIX`-scoped viewer id so the
 * visibility refcount in `terminalPanelManager` stays correct.
 */

const VISIBILITY_REFRESH_MS = 60_000;
/** Tiles show recent context only; a deep buffer would cost memory per tile. */
const TILE_SCROLLBACK = 600;
const LINE_HEIGHT = 1.2;
/** Legibility floor and a ceiling that keeps tiles from looking oversized. */
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 13;
/** The focus view has room to breathe, so it may go a little larger. */
const MAX_FOCUS_FONT_SIZE = 16;
/** Fallbacks when a panel has no live PTY to report dimensions. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_VIEWER_COLS = 400;
/** Ignore sub-column jitter so a resize doesn't rebuild the terminal. */
const COLUMN_CHANGE_THRESHOLD = 2;
const RESIZE_DEBOUNCE_MS = 200;

const VIEWER_ID = getMissionControlViewerId();

const terminalOutputPayloadSchema = boundary.object({
  panelId: boundary.string,
  output: boundary.string,
});

const terminalStateSchema = boundary.object({
  serializedBuffer: boundary.optional(boundary.string),
  scrollbackBuffer: boundary.optional(boundary.union(boundary.string, boundary.array(boundary.string))),
});

function getMissionControlViewerId(): string {
  const storageKey = 'pane.missionControl.terminalViewerId';
  const id = `${MISSION_CONTROL_VIEWER_PREFIX}:${window.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    window.sessionStorage.setItem(storageKey, id);
  } catch {
    // A locked-down storage profile costs viewer-id stability across reloads,
    // not the view: the stale-viewer sweep clears the orphan.
  }
  return id;
}

/**
 * Width of a character cell relative to the font size, measured once offscreen.
 *
 * Geometry has to be known *before* the terminal is constructed: calling
 * `terminal.resize()` after content has been written discards the
 * alternate-screen buffer, which is where full-screen agent TUIs live — the
 * tile then renders blank.
 */
const cachedCharRatios = new Map<string, number>();

function charWidthRatio(fontFamily: string): number {
  const cached = cachedCharRatios.get(fontFamily);
  if (cached !== undefined) return cached;

  const reference = 20;
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${fontFamily};font-size:${reference}px;`;
  probe.textContent = 'M'.repeat(100);
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 100;
  probe.remove();

  const ratio = width > 0 ? width / reference : 0.6;
  // Keyed by family: the column-fit maths is only correct when the font it
  // measured is the font the terminal renders in.
  cachedCharRatios.set(fontFamily, ratio);
  return ratio;
}

interface ViewerGeometry {
  fontSize: number;
  cols: number;
  rows: number;
}

/** DEC private mode for focus in/out reporting. */
const FOCUS_REPORTING_MODE = 1004;

/**
 * Keep the viewer from talking back to the agent.
 *
 * A tile is a *second* view of a PTY that already has one. Terminal queries —
 * cursor position (`CSI 6 n`), device attributes (`CSI c`), version, window
 * size — are answered by xterm through the very same `onData` stream that
 * carries keystrokes, so an interactive tile would inject answers to questions
 * the agent asked the *real* terminal. Codex places its inline viewport from
 * the cursor-position report: a second, differently-positioned answer moves its
 * idea of where the screen starts, and every redraw after that — including the
 * highlighted row of an approval prompt — lands on the wrong lines. That is why
 * a Codex pane looked frozen in Mission Control while a Claude pane, which asks
 * nothing, took input fine.
 *
 * Swallowing the queries (returning `true` marks them handled, so xterm's
 * built-in reply never runs) leaves the real panel as the single voice on the
 * PTY. Focus reporting goes the same way: a tile gaining focus is not the
 * agent's terminal gaining focus.
 */
function suppressTerminalReplies(terminal: Terminal): IDisposable[] {
  const swallow = () => true;
  const swallowFocusReporting = (params: (number | number[])[]) =>
    params.length === 1 && params[0] === FOCUS_REPORTING_MODE;

  return [
    terminal.parser.registerCsiHandler({ final: 'n' }, swallow),                     // DSR
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow),        // DECDSR
    terminal.parser.registerCsiHandler({ final: 'c' }, swallow),                     // DA1
    terminal.parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow),        // DA2
    terminal.parser.registerCsiHandler({ prefix: '=', final: 'c' }, swallow),        // DA3
    terminal.parser.registerCsiHandler({ prefix: '>', final: 'q' }, swallow),        // XTVERSION
    terminal.parser.registerCsiHandler({ final: 't' }, swallow),                     // window reports
    terminal.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow), // DECRQM
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, swallowFocusReporting),
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, swallowFocusReporting),
  ];
}

/**
 * Park the viewport on the last line that actually has content.
 *
 * `scrollToBottom()` lands on the true end of the buffer, which for an agent
 * waiting on a decision is a run of blank rows below its prompt — the tile
 * then looks like it scrolled the important part away. Finding the last
 * non-empty row and putting it at the bottom keeps the question on screen.
 */
function scrollToLastContent(terminal: Terminal): void {
  const buffer = terminal.buffer.active;
  let lastContentLine = -1;

  for (let i = buffer.length - 1; i >= 0; i--) {
    const text = buffer.getLine(i)?.translateToString(true) ?? '';
    if (text.trim().length > 0) {
      lastContentLine = i;
      break;
    }
  }

  if (lastContentLine < 0) {
    terminal.scrollToBottom();
    return;
  }

  // Put that line on the last visible row.
  terminal.scrollToLine(Math.max(0, lastContentLine - terminal.rows + 1));
}

/**
 * Grid rows below the agent's last line of content.
 *
 * An agent's screen is usually taller than what it has drawn: Claude paints its
 * question near the top of the PTY and leaves the rest of the rows empty.
 * Scrolling cannot remove them — they are inside the viewport, not above it —
 * so a tile that simply shows the bottom of the grid shows blank space, and the
 * options the user is supposed to choose between are clipped off the top. The
 * count returned here is how far the terminal must be pushed down (and out of
 * the tile) for its content to end where the tile ends.
 *
 * The cursor row always counts as content: an empty prompt line the user is
 * typing into must never be the thing that gets pushed out of sight.
 */
function trailingBlankRows(terminal: Terminal): number {
  const buffer = terminal.buffer.active;
  const bottom = buffer.viewportY + terminal.rows - 1;
  const cursorRow = buffer.viewportY + buffer.cursorY;

  for (let row = bottom; row > buffer.viewportY; row--) {
    if (row <= cursorRow) return Math.max(0, bottom - cursorRow);
    const text = buffer.getLine(row)?.translateToString(true) ?? '';
    if (text.trim().length > 0) return bottom - row;
  }

  return 0;
}

/**
 * xterm's helper textarea is focusable, and a non-interactive tile hides its
 * whole surface from the accessibility tree. Match the two so a screen reader's
 * focus can never land inside an `aria-hidden` subtree.
 */
function syncHelperTextareaFocusability(container: HTMLElement | null, interactive: boolean): void {
  const helper = container?.querySelector('textarea.xterm-helper-textarea');
  if (helper instanceof HTMLTextAreaElement) helper.tabIndex = interactive ? 0 : -1;
}

/** Rendered height of one row, measured rather than recomputed from the font. */
function measuredRowHeight(container: HTMLElement, terminal: Terminal): number {
  // SAFETY: `.xterm-screen` is an element xterm renders into this container, so the match is an HTMLElement.
  const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
  if (screen && terminal.rows > 0 && screen.clientHeight > 0) {
    return screen.clientHeight / terminal.rows;
  }
  return terminal.options.fontSize ? terminal.options.fontSize * LINE_HEIGHT : 0;
}

export interface UseMissionControlTerminalOptions {
  panelId: string | null;
  /** Live PTY dimensions — the reference the agent's output was drawn for. */
  cols: number | null;
  rows: number | null;
  /** True when the agent is painting a full-screen TUI. */
  /**
   * Accept keystrokes and forward them to the real PTY. Enabled only for the
   * tile the user has explicitly focused — typing into the wrong agent is not
   * a recoverable mistake.
   */
  interactive?: boolean;
  /**
   * Reproduce the PTY's grid exactly — same columns *and* rows — and shrink the
   * font until the whole thing fits the box.
   *
   * For the expanded focus view, where the point is to see the agent's entire
   * screen at once. A tile that stays preview-sized instead keeps the preview's
   * font and simply clips, which is what makes typing in place look like
   * nothing changed.
   */
  matchPtyExactly?: boolean;
  /**
   * Forward Escape to the agent instead of treating it as "I am done typing
   * here". Off by default: leaving a tile is the far more common intent, and an
   * Escape that cannot be taken back is a bad default in a grid of agents.
   */
  sendEscape?: boolean;
  /** Called when Escape is used to leave typing mode. */
  onEscapeExit?: () => void;
}

export function useMissionControlTerminal({
  panelId,
  cols,
  rows,
  interactive = false,
  matchPtyExactly = false,
  sendEscape = false,
  onEscapeExit,
}: UseMissionControlTerminalOptions) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A tile mirrors a real panel, so it renders in the typeface that panel does.
  const userFont = useConfigStore(state => state.config?.terminalFontFamily) || DEFAULT_TERMINAL_FONT_FAMILY;
  const fontFamily = buildTerminalFontFamily(userFont);
  const { highContrast } = useTheme();
  // Read inside the persistent onData handler so toggling interactivity does
  // not tear the terminal down. Committed refs rather than writes during
  // render: render has to stay pure, and the layout effect behind them still
  // lands before the browser can deliver the next keystroke.
  const interactiveRef = useCommittedRef(interactive);
  const sendEscapeRef = useCommittedRef(sendEscape);
  const escapeExitRef = useCommittedRef(onEscapeExit);
  // Read once when the terminal is constructed; changes are applied live below
  // rather than by rebuilding a tile mid-stream.
  const fontFamilyRef = useCommittedRef(fontFamily);
  const highContrastRef = useCommittedRef(highContrast);

  /**
   * Pixels the terminal is pushed below the tile so its content ends where the
   * tile does. See `trailingBlankRows`.
   */
  const [bottomOverflow, setBottomOverflow] = useState(0);
  /** True when the PTY is wider than the tile, so text is cut off on the right. */
  const [clippedRight, setClippedRight] = useState(false);

  // Dimensions are sticky: a poll that momentarily reports null (panel between
  // states) must not tear the terminal down and rebuild it at a default size.
  // Reading the ref during render is fine; the write belongs in an effect.
  const lastDimsRef = useRef({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  const hasReportedDims = Boolean(cols && cols > 0 && rows && rows > 0);
  const ptyCols = hasReportedDims ? cols! : lastDimsRef.current.cols;
  const ptyRows = hasReportedDims ? rows! : lastDimsRef.current.rows;
  useLayoutEffect(() => {
    if (hasReportedDims) lastDimsRef.current = { cols: cols!, rows: rows! };
  }, [hasReportedDims, cols, rows]);

  const [geometry, setGeometry] = useState<ViewerGeometry>({
    fontSize: MAX_FONT_SIZE,
    cols: ptyCols,
    rows: ptyRows,
  });

  const measure = useCallback((width: number, height: number): ViewerGeometry => {
    const ratio = charWidthRatio(fontFamily);

    if (matchPtyExactly) {
      // Fit the whole grid — both axes — and let the font shrink to suit.
      const byWidth = width / Math.max(ptyCols, 1) / ratio;
      const byHeight = height / Math.max(ptyRows, 1) / LINE_HEIGHT;
      const fontSize = Math.max(
        Math.min(Math.floor(Math.min(byWidth, byHeight)), MAX_FOCUS_FONT_SIZE),
        MIN_FONT_SIZE
      );
      return { fontSize, cols: ptyCols, rows: ptyRows };
    }

    // Largest font at which the PTY's full width still fits the tile, held
    // between a legible floor and a sane ceiling.
    const ideal = width / Math.max(ptyCols, 1) / ratio;
    const fontSize = Math.round(Math.min(Math.max(ideal, MIN_FONT_SIZE), MAX_FONT_SIZE));

    return {
      fontSize,
      // The PTY's width, exactly — see rule 1.
      cols: Math.min(ptyCols, MAX_VIEWER_COLS),
      // The PTY's height, always. A TUI redrawing its selection list against
      // more rows than the viewer has scatters those redraws, and the terminal
      // is bottom-anchored, so a taller grid still shows the same trailing
      // lines. Deriving rows from the tile instead would make `rows` change the
      // moment a tile takes the keyboard, and `rows` is what the terminal
      // effect rebuilds on: focusing would cost a teardown and a re-hydrate at
      // exactly the moment the user starts typing.
      rows: ptyRows,
    };
  }, [ptyCols, ptyRows, matchPtyExactly, fontFamily]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const sync = () => {
      const next = measure(wrapper.clientWidth, wrapper.clientHeight);
      setGeometry(current => (
        next.fontSize !== current.fontSize
        || Math.abs(next.cols - current.cols) >= COLUMN_CHANGE_THRESHOLD
        || Math.abs(next.rows - current.rows) >= 1
          ? next
          : current
      ));
    };
    sync();

    let debounce: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(sync, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(wrapper);

    return () => {
      window.clearTimeout(debounce);
      observer.disconnect();
    };
  }, [measure]);

  useEffect(() => {
    const container = containerRef.current;
    if (!panelId || !container) return;

    // Geometry changes rebuild the terminal, and a rebuild that ignored the
    // current interactivity would hand the user a fresh, mute terminal: the
    // effect below only fires when `interactive` *changes*, which it does not
    // during a rebuild. That is what made a focused tile stop accepting input
    // the moment its tile resized.
    const startsInteractive = interactiveRef.current;

    const terminal = new Terminal({
      allowProposedApi: true,
      // No `convertEol`: a tile replays and then follows the same byte stream
      // the real panel does, and rewriting bare LFs as CRLF shifts every line a
      // TUI paints without one.
      cursorBlink: startsInteractive,
      disableStdin: !startsInteractive,
      scrollOnUserInput: true,
      // Sized correctly up front — never resized once content exists.
      cols: geometry.cols,
      rows: geometry.rows,
      fontSize: geometry.fontSize,
      lineHeight: LINE_HEIGHT,
      fontFamily: fontFamilyRef.current,
      scrollback: TILE_SCROLLBACK,
      // Agent TUIs paint their own backgrounds assuming a dark terminal. In a
      // light theme that lands as dark-on-dark; this floor keeps it legible.
      minimumContrastRatio: getMinimumContrastRatio(highContrastRef.current),
      // The app's real terminal palette. A transparent background leaves cells
      // the TUI never paints showing the tile's surface colour instead of the
      // terminal's, which reads as a broken, patchy background.
      theme: getTerminalTheme(),
    });

    terminal.open(container);
    terminalRef.current = terminal;
    // A non-interactive tile marks its surface `aria-hidden`, and xterm mounts a
    // focusable helper textarea inside it. Taking that textarea out of the tab
    // order keeps focus from landing inside a hidden subtree.
    syncHelperTextareaFocusability(container, startsInteractive);
    const replySuppressors = suppressTerminalReplies(terminal);
    if (startsInteractive) terminal.focus();

    // Escape leaves typing mode by default; the agent only receives it when the
    // user has explicitly asked for that. Handled here rather than on `onData`
    // so xterm never writes the sequence in the first place.
    terminal.attachCustomKeyEventHandler(event => {
      if (event.key !== 'Escape' || !interactiveRef.current || sendEscapeRef.current) return true;
      if (event.type === 'keydown') escapeExitRef.current?.();
      return false;
    });

    let disposed = false;
    /** True while the user is reading further up; suppresses auto-scroll. */
    let pinnedByUser = false;

    const syncOverflow = () => {
      if (disposed) return;
      const rowHeight = measuredRowHeight(container, terminal);
      const overflow = Math.round(trailingBlankRows(terminal) * rowHeight);
      setBottomOverflow(current => (current === overflow ? current : overflow));

      // SAFETY: `.xterm-screen` is an element xterm renders into this container, so the match is an HTMLElement.
      const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
      const available = wrapperRef.current?.clientWidth ?? 0;
      const clipped = Boolean(screen && available > 0 && screen.clientWidth > available + 1);
      setClippedRight(current => (current === clipped ? current : clipped));
    };

    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      const atBottom = buffer.viewportY >= buffer.baseY - 1;
      pinnedByUser = !atBottom;
    });

    // Keystrokes reach the real PTY only for the focused tile.
    const inputDisposable = terminal.onData(data => {
      if (!interactiveRef.current) return;
      void window.electronAPI.invoke('terminal:input', panelId, data).catch(() => {});
    });

    const unsubscribe = window.electronAPI.events.onTerminalOutput((payload: TerminalOutputEvent) => {
      // The output event is broadcast for every panel; reject the ones that are
      // not ours before paying for a decode.
      if (!('panelId' in payload) || payload.panelId !== panelId) return;
      const data = decodeOptionalBoundary(payload, terminalOutputPayloadSchema);
      if (!data) return;
      terminal.write(data.output, () => {
        if (disposed) return;
        // Follow new output, but never yank the view away from someone who
        // scrolled up to read.
        if (!pinnedByUser) scrollToLastContent(terminal);
        syncOverflow();
      });
      // Flow control is byte-counted per panel; a viewer that writes must ack.
      void window.electronAPI.invoke('terminal:ack', panelId, terminalOutputByteLength(data.output)).catch(() => {});
    });

    // Main only treats a panel as visible while a viewer says so, and viewer
    // entries go stale after a few minutes without a heartbeat.
    const visibilityTimer = window.setInterval(() => {
      void window.electronAPI.invoke('terminal:setVisibility', panelId, true, VIEWER_ID).catch(() => {});
    }, VISIBILITY_REFRESH_MS);

    const hydrate = async () => {
      try {
        const state = decodeOptionalBoundary(
          await window.electronAPI.invoke('terminal:getState', panelId),
          terminalStateSchema,
        );
        if (disposed) return;
        const scrollback = state?.scrollbackBuffer;
        const restore = state?.serializedBuffer
          ?? (Array.isArray(scrollback) ? scrollback.join('\n') : scrollback ?? '');
        if (restore) {
          terminal.write(restore, () => {
            if (disposed) return;
            scrollToLastContent(terminal);
            syncOverflow();
          });
        }
        await window.electronAPI.invoke('terminal:setVisibility', panelId, true, VIEWER_ID);
        if (disposed) return;
        setError(null);
        // Hydration writes into the DOM the user just clicked; take the
        // keyboard back afterwards so the first keystroke lands on the agent.
        if (interactiveRef.current) terminal.focus();
      } catch (err: unknown) {
        if (!disposed) setError(err instanceof Error ? err.message : 'Could not attach to terminal');
      }
    };

    void hydrate();

    return () => {
      disposed = true;
      window.clearInterval(visibilityTimer);
      unsubscribe();
      inputDisposable.dispose();
      scrollDisposable.dispose();
      for (const suppressor of replySuppressors) suppressor.dispose();
      void window.electronAPI.invoke('terminal:setVisibility', panelId, false, VIEWER_ID).catch(() => {});
      // Never call clearTextureAtlas() here — it would poison other terminals.
      terminal.dispose();
      terminalRef.current = null;
    };
    // Geometry changes rebuild and re-hydrate rather than resizing a live
    // terminal — see the note on charWidthRatio.
  }, [panelId, geometry, interactiveRef, sendEscapeRef, escapeExitRef, fontFamilyRef, highContrastRef]);

  // A font or theme change is an option flip too: rebuilding every live tile
  // for a settings change would re-hydrate each one for nothing.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = fontFamily;
    terminal.options.minimumContrastRatio = getMinimumContrastRatio(highContrast);
  }, [fontFamily, highContrast]);

  // Toggling interactivity flips an option rather than rebuilding, so focusing
  // a tile never costs a re-hydrate.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !interactive;
    terminal.options.cursorBlink = interactive;
    syncHelperTextareaFocusability(containerRef.current, interactive);
    if (interactive) terminal.focus();
  }, [interactive]);

  /**
   * Hand the keyboard to this terminal.
   *
   * Clicks that land on the tile's padding — or on the chrome around the
   * terminal — otherwise leave focus on whatever the user clicked last, and the
   * keystrokes go nowhere.
   */
  const focusTerminal = useCallback(() => {
    if (!interactiveRef.current) return;
    terminalRef.current?.focus();
  }, [interactiveRef]);

  return { wrapperRef, containerRef, error, focusTerminal, bottomOverflow, clippedRight };
}
