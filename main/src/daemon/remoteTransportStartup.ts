interface RemoteTransportStartupController {
  syncToConfig(): Promise<void>;
}

export async function syncRemoteTransportForMode(
  controller: RemoteTransportStartupController,
  mode: 'desktop' | 'headless',
  cleanupHeadlessFailure: () => Promise<void>,
): Promise<void> {
  try {
    await controller.syncToConfig();
  } catch (error) {
    if (mode === 'headless') {
      await cleanupHeadlessFailure();
      throw error;
    }
    console.error('[Pane remote daemon] Failed to start remote HTTP transport; continuing without remote access', error);
  }
}
