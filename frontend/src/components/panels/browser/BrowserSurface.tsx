import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, RotateCw } from 'lucide-react';
import { cn } from '../../../utils/cn';
import { panelApi } from '../../../services/panelApi';
import { usePanelStore } from '../../../stores/panelStore';

const SHARED_PANE_BROWSER_PARTITION = 'persist:pane-browser';

interface BrowserSurfaceProps {
  panelId: string;
  sessionId: string;
  url: string;
  isActive: boolean;
  compact?: boolean;
}

const BrowserSurface: React.FC<BrowserSurfaceProps> = ({
  panelId,
  sessionId,
  url,
  isActive,
  compact = false,
}) => {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const addPanel = usePanelStore((state) => state.addPanel);
  const setActivePanelInStore = usePanelStore((state) => state.setActivePanel);

  const handleBack = useCallback(() => {
    webviewRef.current?.goBack();
  }, []);

  const handleForward = useCallback(() => {
    webviewRef.current?.goForward();
  }, []);

  const handleRefresh = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const updateNavState = () => {
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };

    const onDomReady = () => {
      const wcId = webview.getWebContentsId();
      window.electronAPI?.invoke('browser-panel:register-webview', wcId, panelId, sessionId);
      updateNavState();
    };

    const onDidNavigate = () => {
      updateNavState();
      setIsLoading(false);
    };

    const onDidStartLoading = () => setIsLoading(true);
    const onDidStopLoading = () => {
      setIsLoading(false);
      updateNavState();
    };

    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('did-navigate', onDidNavigate);
    webview.addEventListener('did-navigate-in-page', onDidNavigate);
    webview.addEventListener('did-start-loading', onDidStartLoading);
    webview.addEventListener('did-stop-loading', onDidStopLoading);

    return () => {
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('did-navigate', onDidNavigate);
      webview.removeEventListener('did-navigate-in-page', onDidNavigate);
      webview.removeEventListener('did-start-loading', onDidStartLoading);
      webview.removeEventListener('did-stop-loading', onDidStopLoading);
    };
  }, [panelId, sessionId, url]);

  useEffect(() => {
    const handler = (event: Event) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      const { url: popupUrl, sourceSessionId, sourcePanelId } = (event as CustomEvent<{
        url: string;
        sourceSessionId: string;
        sourcePanelId: string;
      }>).detail;
      if (sourceSessionId !== sessionId || sourcePanelId !== panelId) return;

      event.stopImmediatePropagation();
      let title = 'Popup';
      try {
        title = new URL(popupUrl).hostname || 'Popup';
      } catch {
        title = 'Popup';
      }

      panelApi.createPanel({
        sessionId,
        type: 'browser',
        title,
        initialState: { customState: { currentUrl: popupUrl, isPopup: true } },
      }).then(async (newPanel) => {
        addPanel(newPanel);
        setActivePanelInStore(sessionId, newPanel.id);
        await panelApi.setActivePanel(sessionId, newPanel.id);
      }).catch((error) => {
        console.error('[BrowserSurface] Failed to create popup panel:', error);
      });
    };

    window.addEventListener('browser-panel:popup-requested', handler);
    return () => window.removeEventListener('browser-panel:popup-requested', handler);
  }, [panelId, sessionId, addPanel, setActivePanelInStore]);

  useEffect(() => {
    if (!isActive) {
      setIsLoading(false);
    }
  }, [isActive]);

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <div className={cn(
        "flex items-center gap-1.5 border-b border-border-primary bg-bg-chrome flex-shrink-0",
        compact ? "px-2 py-1" : "px-2 py-1.5",
      )}>
        <button
          onClick={handleBack}
          disabled={!canGoBack}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !canGoBack && 'opacity-30 cursor-not-allowed'
          )}
          title="Back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleForward}
          disabled={!canGoForward}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !canGoForward && 'opacity-30 cursor-not-allowed'
          )}
          title="Forward"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleRefresh}
          className="p-1 rounded hover:bg-surface-hover transition-colors"
          title="Refresh"
        >
          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCw className="w-3.5 h-3.5" />
          )}
        </button>
        <div className="flex-1 min-w-0 truncate text-xs text-text-tertiary px-2">
          {url}
        </div>
      </div>

      <webview
        ref={webviewRef}
        src={url}
        // Review uses a shared Pane browser profile so GitHub auth persists across panes.
        partition={SHARED_PANE_BROWSER_PARTITION}
        allowpopups
        className="flex-1 border-0"
        style={{ display: 'inline-flex' }}
      />
    </div>
  );
};

export default BrowserSurface;
