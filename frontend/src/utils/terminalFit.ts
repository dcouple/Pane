/**
 * Fitting a monospace screen into a Mission Control tile.
 *
 * A tile is a fraction of the width the real terminal panel gets, and it must
 * never resize the agent's PTY — the PTY's width is what the agent painted
 * against, and changing it would reflow output the agent has already drawn. So
 * the only lever a tile has is the font size.
 *
 * Both tile bodies fit through here: the live terminal and the cheap snapshot
 * it is promoted from. Sharing the maths is the point — a tile that fitted one
 * way as a snapshot and another way once live would visibly jump the moment the
 * pointer landed on it.
 */

/** Legibility floor and a ceiling that keeps tiles from looking oversized. */
export const MIN_TILE_FONT_SIZE = 9;
export const MAX_TILE_FONT_SIZE = 13;
/** The focus view has room to breathe, so it may go a little larger. */
export const MAX_FOCUS_FONT_SIZE = 16;
export const TILE_LINE_HEIGHT = 1.2;

/**
 * Space the rendered terminal occupies on top of its glyphs: the `.xterm`
 * padding on both sides plus the `.xterm-screen` left margin, as set in
 * index.css. Choosing a font against the raw box instead leaves the trailing
 * column outside it, and a column that lands outside a tile whose overflow is
 * hidden reads as a hard cut mid-word.
 */
export const TERMINAL_CHROME_X = 18;
export const TERMINAL_CHROME_Y = 15;

/**
 * Width of a character cell relative to the font size, measured once offscreen.
 *
 * Geometry has to be known *before* a terminal is constructed: calling
 * `terminal.resize()` after content has been written discards the
 * alternate-screen buffer, which is where full-screen agent TUIs live — the
 * tile then renders blank.
 */
/** A character cell's size relative to the font size it was measured at. */
interface CellRatios {
  width: number;
  height: number;
}

const cachedCharRatios = new Map<string, CellRatios>();

function measureCell(fontFamily: string): CellRatios {
  const cached = cachedCharRatios.get(fontFamily);
  if (cached !== undefined) return cached;

  const reference = 20;
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${fontFamily};font-size:${reference}px;`;
  probe.textContent = 'M'.repeat(100);
  document.body.appendChild(probe);
  const box = probe.getBoundingClientRect();
  const width = box.width / 100;
  const height = box.height;
  probe.remove();

  // Keyed by family: the fit maths is only correct when the font it measured is
  // the font the text renders in.
  const ratios = {
    width: width > 0 ? width / reference : 0.6,
    height: height > 0 ? height / reference : 1.3,
  };
  cachedCharRatios.set(fontFamily, ratios);
  return ratios;
}

export function charWidthRatio(fontFamily: string): number {
  return measureCell(fontFamily).width;
}

/**
 * Height of a character cell relative to the font size.
 *
 * Not 1: a font's natural line box is taller than its size, and xterm's
 * `lineHeight` option multiplies that box rather than the size. Assuming a row
 * is `fontSize * lineHeight` therefore under-counts every row — for the default
 * terminal font by about a quarter — and a grid fitted with that estimate comes
 * out taller than the box it was fitted to.
 */
export function charHeightRatio(fontFamily: string): number {
  return measureCell(fontFamily).height;
}


/**
 * Largest font at which `columns` cells still fit `width`, held between the
 * legibility floor and the caller's ceiling.
 *
 * The cell ratio is passed in rather than measured here: the caller already
 * knows which font family it is about to render in, and keeping the arithmetic
 * free of the DOM is what makes it testable.
 *
 * Below the floor the answer is the floor: shrinking further would trade text
 * nobody can read for text that merely fits, so the surplus columns are clipped
 * instead and the caller says so.
 */
export function fitFontSize(
  width: number,
  columns: number,
  ratio: number,
  maxFontSize: number = MAX_TILE_FONT_SIZE,
): number {
  const ideal = width / Math.max(columns, 1) / ratio;
  return Math.round(Math.min(Math.max(ideal, MIN_TILE_FONT_SIZE), maxFontSize));
}

/** Rendered width of `columns` cells at this font, chrome included. */
export function fittedWidth(fontSize: number, columns: number, ratio: number): number {
  return columns * fontSize * ratio + TERMINAL_CHROME_X;
}

/**
 * Columns in a block of already-rendered terminal text.
 *
 * A snapshot of a stopped pane carries no PTY dimensions, so the text itself is
 * the only record of how wide the screen was when it was painted.
 */
export function widestLine(text: string): number {
  let widest = 0;
  for (const line of text.split('\n')) {
    if (line.length > widest) widest = line.length;
  }
  return widest;
}
