/**
 * Daemon-owned event delivery contract.
 *
 * The current Electron app will back this with `webContents.send(...)`, but the
 * contract is intentionally transport-agnostic so a future local socket,
 * WebSocket, or relay-backed client can subscribe to the same runtime events.
 * Auth, pairing, relay policy, and hosted VM lifecycle stay above this seam.
 */
export interface PaneEventSink {
  send(channel: string, ...args: unknown[]): void;
}

/**
 * Safe default sink for tests and boot phases that should not emit renderer
 * events yet.
 */
export const noopPaneEventSink: PaneEventSink = {
  send: () => undefined,
};

/**
 * Fan events out to multiple clients. One client error should not prevent
 * delivery to the rest of the connected sinks.
 */
export function createFanoutEventSink(sinks: readonly PaneEventSink[]): PaneEventSink {
  return {
    send(channel: string, ...args: unknown[]) {
      let firstError: unknown;

      for (const sink of sinks) {
        try {
          sink.send(channel, ...args);
        } catch (error) {
          firstError ??= error;
        }
      }

      if (firstError) {
        throw firstError;
      }
    },
  };
}
