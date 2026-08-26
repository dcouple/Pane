/**
 * Opens (or re-targets) the session's Browser panel at an HTML file.
 */
import type { BrowserPanelState, ToolPanel } from '../../../../../shared/types/panels';
import { boundary, decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';
import { panelApi } from '../../../services/panelApi';
import { usePanelStore } from '../../../stores/panelStore';

const filePathResponseSchema = boundary.object({
  success: boundary.boolean,
  url: boundary.optional(boundary.string),
  error: boundary.optional(boundary.string),
});

export async function previewHtmlFileInBrowser(sessionId: string, filePath: string): Promise<void> {
  const result = decodeBoundary(
    await window.electronAPI.invoke('file:getPath', { sessionId, filePath }),
    filePathResponseSchema,
  );
  if (!result.success || !result.url) {
    throw new Error(result.error || 'Failed to resolve HTML preview URL');
  }

  const store = usePanelStore.getState();
  const existingPanel = store.getSessionPanels(sessionId).find((candidate) => candidate.type === 'browser');
  const title = filePath.split('/').pop() || 'Browser';
  let browserPanel: ToolPanel;

  if (existingPanel) {
    // SAFETY: The browser panel type discriminator establishes BrowserPanelState.
    const existingCustomState = (existingPanel.state.customState ?? {}) as BrowserPanelState;
    browserPanel = {
      ...existingPanel,
      title,
      state: { ...existingPanel.state, customState: { ...existingCustomState, currentUrl: result.url } },
    };
    await panelApi.updatePanel(browserPanel.id, { title, state: browserPanel.state });
    store.updatePanelState(browserPanel);
  } else {
    browserPanel = await panelApi.createPanel({
      sessionId,
      type: 'browser',
      title,
      initialState: { customState: { currentUrl: result.url } },
    });
    store.addPanel(browserPanel);
  }

  store.setActivePanel(sessionId, browserPanel.id);
  await panelApi.setActivePanel(sessionId, browserPanel.id);
  window.dispatchEvent(new CustomEvent('browser-panel:navigate', { detail: { url: result.url, sessionId } }));
}
