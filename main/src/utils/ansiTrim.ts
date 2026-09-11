/**
 * Drop the oldest bytes of a terminal byte log without leaving a torn ANSI
 * escape sequence at the new start. Shared by the in-memory PTY buffers in
 * TerminalPanelManager and the persisted `panel_buffers` cap.
 */
export function trimAnsiSafe(buffer: string, maxSize: number): string {
  if (buffer.length <= maxSize) return buffer;

  let start = buffer.length - maxSize;

  // Prefer a line boundary so replay starts from a sane row.
  const nextNewline = buffer.indexOf('\n', start);
  if (nextNewline !== -1 && nextNewline < buffer.length - 1) {
    start = nextNewline + 1;
  }

  // If the cut lands inside a common ANSI escape sequence, advance past it.
  const lastEsc = buffer.lastIndexOf('\x1b', start);
  if (lastEsc !== -1) {
    let sequenceEnd = -1;
    const introducer = buffer[lastEsc + 1];

    if (introducer === '[') {
      const finalByte = buffer.slice(lastEsc + 2).search(/[@-~]/);
      sequenceEnd = finalByte === -1 ? -1 : lastEsc + 2 + finalByte;
    } else if (introducer === ']') {
      const belEnd = buffer.indexOf('\x07', lastEsc + 2);
      const stEnd = buffer.indexOf('\x1b\\', lastEsc + 2);
      if (belEnd !== -1 && stEnd !== -1) {
        sequenceEnd = Math.min(belEnd, stEnd + 1);
      } else if (belEnd !== -1) {
        sequenceEnd = belEnd;
      } else if (stEnd !== -1) {
        sequenceEnd = stEnd + 1;
      }
    } else if (introducer) {
      sequenceEnd = lastEsc + 1;
    }

    if (sequenceEnd === -1) {
      start = buffer.length;
    } else if (sequenceEnd >= start) {
      start = sequenceEnd + 1;
    }
  }

  return buffer.slice(start);
}
