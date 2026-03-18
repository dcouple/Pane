import type { IBuffer } from '@xterm/xterm';

export interface TerminalSearchMatch {
  row: number;    // absolute row in buffer (0-based, includes scrollback)
  col: number;    // column offset in the line
  length: number; // match length in characters
}

export interface TerminalSearchResult {
  found: boolean;
  currentIndex: number;
  total: number;
}

/**
 * Scan the entire terminal buffer for case-insensitive matches of `query`.
 * Handles soft-wrapped lines by accumulating physical lines where the next
 * line has `isWrapped === true`, then searching the logical (joined) line and
 * mapping matches back to their physical row + column.
 */
export function collectTerminalSearchMatches(
  buffer: IBuffer,
  query: string
): TerminalSearchMatch[] {
  const matches: TerminalSearchMatch[] = [];

  if (!query) return matches;

  const lowerQuery = query.toLocaleLowerCase();

  let row = 0;
  while (row < buffer.length) {
    const line = buffer.getLine(row);
    if (!line) {
      row++;
      continue;
    }

    const startRow = row;
    let logicalLine = line.translateToString();
    const rowLengths = [logicalLine.length];

    // isWrapped on the NEXT line means it is a continuation of THIS line
    while (row + 1 < buffer.length) {
      const nextLine = buffer.getLine(row + 1);
      if (!nextLine || !nextLine.isWrapped) break;
      row++;
      const nextText = nextLine.translateToString();
      rowLengths.push(nextText.length);
      logicalLine += nextText;
    }

    const lowerLogical = logicalLine.toLocaleLowerCase();
    let searchCol = 0;

    while (searchCol < lowerLogical.length) {
      const idx = lowerLogical.indexOf(lowerQuery, searchCol);
      if (idx === -1) break;

      // Map the logical column index back to a physical row + column
      let remaining = idx;
      let physRow = startRow;
      for (let i = 0; i < rowLengths.length; i++) {
        if (remaining < rowLengths[i]) {
          physRow = startRow + i;
          break;
        }
        remaining -= rowLengths[i];
      }

      matches.push({ row: physRow, col: remaining, length: query.length });
      searchCol = idx + 1;
    }

    row++;
  }

  return matches;
}

/**
 * Given the current match index and a direction, return the index of the next
 * match (wrapping around). Returns -1 when there are no matches.
 */
export function getNextTerminalSearchIndex(
  matches: TerminalSearchMatch[],
  currentIndex: number,
  direction: 'next' | 'prev'
): number {
  if (matches.length === 0) return -1;

  if (direction === 'next') {
    return (currentIndex + 1) % matches.length;
  }

  // prev — wrap from 0 to last
  return (currentIndex - 1 + matches.length) % matches.length;
}
