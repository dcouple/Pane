/**
 * Inline image support in Pane terminals, provided by `@xterm/addon-image`.
 *
 * This is the single source of truth for the feature: TerminalPanel builds the
 * addon options from it, and `runpane doctor --json` reports it so an agent can
 * discover that image-emitting tools work here instead of guessing from the
 * terminal's name.
 */

/** Image protocols a Pane terminal decodes and draws. */
export const TERMINAL_GRAPHICS_PROTOCOLS = ['sixel', 'iterm2', 'kitty'] as const;

export type TerminalGraphicsProtocol = typeof TERMINAL_GRAPHICS_PROTOCOLS[number];

/**
 * Per-terminal image limits. Every panel gets its own decoder and image store,
 * so the addon defaults (128 MB stored, 16M pixels decoded) multiply by the
 * number of open panels. These are sized for a workspace holding a dozen
 * terminals rather than a single one.
 */
export const TERMINAL_IMAGE_LIMITS = {
  /** Stored image bytes per panel, in MB. FIFO eviction past this. */
  storageLimitMb: 48,
  /** 8.4M pixels: one 4K frame. Decoding peaks at two RGBA buffers of this. */
  pixelLimit: 1 << 23,
} as const;

/**
 * The addon answers CSI 14 t / 16 t / 18 t, which is how tools size their output
 * to the pane before drawing.
 */
export const TERMINAL_GRAPHICS_SIZE_REPORTS = true;

/**
 * The plain-language version of the fields above, for agents reading
 * `runpane doctor --json` that would otherwise have to infer what the protocol
 * list means for a given tool.
 */
export const TERMINAL_GRAPHICS_SUMMARY =
  'Pane terminals draw inline images: sixel, iTerm2 inline images, and the kitty graphics protocol. '
  + 'Tools that require kitty graphics, including terminal-browser and terminal-doom, run inside a Pane panel.';
