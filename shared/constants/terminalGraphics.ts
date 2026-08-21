/**
 * Inline image support in Pane terminals, provided by `@xterm/addon-image`.
 *
 * TerminalPanel passes TERMINAL_IMAGE_OPTIONS to the addon verbatim and
 * `runpane doctor --json` derives its report from the same object, so the
 * capability Pane advertises cannot drift from the one it configures. Turning a
 * protocol off here changes both.
 */

/**
 * The addon options Pane runs with. Every protocol flag is set explicitly
 * rather than left to the addon default, so a default change upstream cannot
 * silently alter what Pane supports or what it claims to support.
 *
 * enableSizeReports answers CSI 14/16/18 t. That is not decoration: it is how
 * image-emitting tools ask how big the pane is before drawing.
 *
 * storageLimit and pixelLimit are ceilings on memory the addon allocates
 * lazily, not a baseline reduction. A panel that never shows an image
 * allocates no image storage either way. They matter once images arrive:
 * storageLimit is the FIFO eviction threshold per panel, and pixelLimit is the
 * point at which a single image is rejected as too large. Both are set below
 * the addon defaults (128 MB, 16M pixels) because they are per panel, and a
 * Pane workspace holds a dozen terminals rather than one.
 */
export const TERMINAL_IMAGE_OPTIONS = {
  sixelSupport: true,
  iipSupport: true,
  kittySupport: true,
  enableSizeReports: true,
  /** MB of stored images per panel before FIFO eviction. */
  storageLimit: 48,
  /** 8.4M pixels, one 4K frame. Decoding peaks at two RGBA buffers of this. */
  pixelLimit: 1 << 23,
} as const;

/** Protocol name as reported to agents, mapped to the option that enables it. */
const PROTOCOL_OPTIONS = {
  sixel: 'sixelSupport',
  iterm2: 'iipSupport',
  kitty: 'kittySupport',
} as const;

export type TerminalGraphicsProtocol = keyof typeof PROTOCOL_OPTIONS;

/** The protocols the options above actually enable. */
export function terminalGraphicsProtocols(): TerminalGraphicsProtocol[] {
  // SAFETY: PROTOCOL_OPTIONS is a const literal, so its own keys are exactly
  // TerminalGraphicsProtocol; Object.keys just loses that in its return type.
  const protocols = Object.keys(PROTOCOL_OPTIONS) as TerminalGraphicsProtocol[];
  return protocols.filter((protocol) => TERMINAL_IMAGE_OPTIONS[PROTOCOL_OPTIONS[protocol]]);
}
