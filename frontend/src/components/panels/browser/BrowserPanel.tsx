import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Globe, ArrowLeft, ArrowRight, RotateCw, Loader2 } from 'lucide-react';
import type { ToolPanel, BrowserPanelState } from '../../../../../shared/types/panels';
import { cn } from '../../../utils/cn';
import { panelApi } from '../../../services/panelApi';
import { usePanelStore } from '../../../stores/panelStore';

interface BrowserPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/;

function isLocalhostUrl(url: string): boolean {
  return LOCALHOST_PATTERN.test(url);
}

function normalizeUrl(input: string): string {
  let url = input.trim();
  if (url.startsWith('localhost') || url.startsWith('127.0.0.1') || url.startsWith('[::1]')) {
    url = 'http://' + url;
  }
  return url;
}

const BrowserPanel: React.FC<BrowserPanelProps> = ({ panel, isActive }) => {
  const initRef = useRef(false);
  const [url, setUrl] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [urlError, setUrlError] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);

  const webviewRef = useRef<Electron.WebviewTag>(null);
  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelIdRef = useRef(panel.id);

  const addPanel = usePanelStore((state) => state.addPanel);
  const setActivePanelInStore = usePanelStore((state) => state.setActivePanel);

  // Initialize from persisted state only on mount
  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      const savedState = panel.state.customState as BrowserPanelState | undefined;
      if (savedState?.currentUrl) {
        setUrl(savedState.currentUrl);
        setInputUrl(savedState.currentUrl);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  // Cleanup persist timeout on unmount
  useEffect(() => {
    return () => clearTimeout(persistTimeoutRef.current);
  }, []);

  const persistState = useCallback((newUrl: string) => {
    clearTimeout(persistTimeoutRef.current);
    persistTimeoutRef.current = setTimeout(() => {
      window.electron?.invoke('panels:update', panelIdRef.current, {
        state: { customState: { currentUrl: newUrl } }
      });
    }, 2000);
  }, []);

  const navigateTo = (rawUrl: string) => {
    const normalized = normalizeUrl(rawUrl);
    if (!isLocalhostUrl(normalized)) {
      setUrlError('Only localhost and 127.0.0.1 URLs are supported');
      return;
    }
    setUrlError('');
    setIsLoading(true);
    setUrl(normalized);
    setInputUrl(normalized);
    persistState(normalized);
  };

  const handleBack = () => {
    webviewRef.current?.goBack();
  };

  const handleForward = () => {
    webviewRef.current?.goForward();
  };

  const handleRefresh = () => {
    webviewRef.current?.reload();
  };

  const handleToggleDevTools = () => {
    const webview = webviewRef.current;
    if (!webview) return;
    if (webview.isDevToolsOpened()) {
      webview.closeDevTools();
      setDevToolsOpen(false);
    } else {
      webview.openDevTools();
      setDevToolsOpen(true);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigateTo(inputUrl);
  };

  // Wire webview events when the webview element is mounted.
  // Depends on `url` because the <webview> is only rendered when url is non-empty,
  // so the ref is null until the first URL is set.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      const wcId = webview.getWebContentsId();
      window.electronAPI?.invoke('browser-panel:register-webview', wcId, panel.id, panel.sessionId);
    };

    const onDidNavigate = () => {
      const currentUrl = webview.getURL();
      if (currentUrl && currentUrl !== 'about:blank') {
        setInputUrl(currentUrl);
        persistState(currentUrl);
      }
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
      setIsLoading(false);
    };

    const onDidStartLoading = () => setIsLoading(true);
    const onDidStopLoading = () => {
      setIsLoading(false);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run when url becomes non-empty (webview mounts); persistState reads from refs
  }, [panel.id, url]);

  // Listen for popup-requested events from the main process.
  // Uses stopImmediatePropagation so only the originating browser panel handles the event,
  // preventing duplicate popup panels when multiple browser panels exist in a session.
  useEffect(() => {
    const handler = (e: Event) => {
      const { url: popupUrl, sourceSessionId, sourcePanelId } = (e as CustomEvent<{ url: string; sourceSessionId: string; sourcePanelId: string }>).detail;
      if (sourceSessionId !== panel.sessionId || sourcePanelId !== panel.id) return;
      e.stopImmediatePropagation();
      let title = 'Popup';
      try { title = new URL(popupUrl).hostname || 'Popup'; } catch { /* malformed URL */ }
      panelApi.createPanel({
        sessionId: panel.sessionId,
        type: 'browser',
        title,
        initialState: { customState: { currentUrl: popupUrl, isPopup: true } }
      }).then(async (newPanel) => {
        addPanel(newPanel);
        setActivePanelInStore(panel.sessionId, newPanel.id);
        await panelApi.setActivePanel(panel.sessionId, newPanel.id);
      }).catch((err: unknown) => {
        console.error('[BrowserPanel] Failed to create popup panel:', err);
      });
    };
    window.addEventListener('browser-panel:popup-requested', handler);
    return () => window.removeEventListener('browser-panel:popup-requested', handler);
  }, [panel.sessionId, addPanel, setActivePanelInStore]);

  // Listen for browser-panel:navigate CustomEvents (e.g., from SelectionPopover)
  // Uses stopImmediatePropagation so only the first browser panel for a session handles the event,
  // preventing duplicate navigation when multiple browser panels exist.
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{ url: string; sessionId: string }>;
      if (customEvent.detail.sessionId === panel.sessionId) {
        e.stopImmediatePropagation();
        navigateTo(customEvent.detail.url);
      }
    };
    window.addEventListener('browser-panel:navigate', handler);
    return () => window.removeEventListener('browser-panel:navigate', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- navigateTo reads from refs; re-registering on sessionId change is sufficient
  }, [panel.sessionId]);

  // Suppress unused warning for isActive — kept for API symmetry with other panels
  void isActive;

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Browser chrome */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border-primary bg-bg-chrome flex-shrink-0">
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
          disabled={!url}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !url && 'opacity-30 cursor-not-allowed'
          )}
          title="Refresh"
        >
          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCw className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={handleToggleDevTools}
          disabled={!url}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !url && 'opacity-30 cursor-not-allowed',
            devToolsOpen && 'bg-surface-hover text-text-primary'
          )}
          title="Toggle DevTools"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </button>
        <form onSubmit={handleSubmit} className="flex-1 min-w-0">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => { setInputUrl(e.target.value); setUrlError(''); }}
            placeholder="localhost:3000"
            className={cn(
              'w-full px-2.5 py-1 text-sm rounded bg-bg-primary border border-border-primary',
              'text-text-primary placeholder-text-tertiary',
              'focus:outline-none focus:border-border-focus',
              urlError && 'border-red-500'
            )}
          />
        </form>
      </div>

      {/* Error feedback */}
      {urlError && (
        <div className="text-xs text-red-500 px-2 py-1 bg-bg-primary border-b border-border-primary">
          {urlError}
        </div>
      )}

      {/* Content area */}
      {!url ? (
        <div className="flex-1 flex flex-col items-center justify-center text-text-secondary p-8">
          <Globe className="w-12 h-12 mb-4 opacity-20" />
          <p className="text-sm">No URL loaded</p>
          <p className="text-xs text-text-tertiary mt-1">
            Enter a localhost URL above or select one from terminal output
          </p>
        </div>
      ) : (
        <webview
          ref={webviewRef}
          src={url}
          partition={`persist:session-${panel.sessionId}`}
          allowpopups={'true' as unknown as boolean}
          className="w-full flex-1 border-0"
          style={{ display: 'inline-flex' }}
        />
      )}
    </div>
  );
};

export default BrowserPanel;
