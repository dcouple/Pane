import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Globe, ArrowLeft, ArrowRight, RotateCw, Loader2 } from 'lucide-react';
import type { ToolPanel, BrowserPanelState } from '../../../../../shared/types/panels';
import { cn } from '../../../utils/cn';

interface BrowserPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/;

function isLocalhostUrl(url: string): boolean {
  return LOCALHOST_PATTERN.test(url);
}

function normalizeUrl(input: string): string {
  let url = input.trim();
  if (url.startsWith('localhost') || url.startsWith('127.0.0.1')) {
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
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelIdRef = useRef(panel.id);

  // Initialize from persisted state only on mount
  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      const savedState = panel.state.customState as BrowserPanelState | undefined;
      if (savedState?.currentUrl) {
        setUrl(savedState.currentUrl);
        setInputUrl(savedState.currentUrl);
        setHistory(savedState.history ?? [savedState.currentUrl]);
        setHistoryIndex(savedState.historyIndex ?? 0);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only init; reading panel.state here would cause re-init on every persist round-trip
  }, []);

  // Cleanup persist timeout on unmount
  useEffect(() => {
    return () => clearTimeout(persistTimeoutRef.current);
  }, []);

  const persistState = useCallback((newUrl: string, newHistory: string[], newIndex: number) => {
    clearTimeout(persistTimeoutRef.current);
    persistTimeoutRef.current = setTimeout(() => {
      window.electron?.invoke('panels:update', panelIdRef.current, {
        state: { customState: { currentUrl: newUrl, history: newHistory, historyIndex: newIndex } }
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
    const newHistory = [...history.slice(0, historyIndex + 1), normalized];
    const newIndex = newHistory.length - 1;
    setHistory(newHistory);
    setHistoryIndex(newIndex);
    setUrl(normalized);
    setInputUrl(normalized);
    persistState(normalized, newHistory, newIndex);
  };

  const handleBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      const newUrl = history[newIndex];
      setHistoryIndex(newIndex);
      setUrl(newUrl);
      setInputUrl(newUrl);
      setIsLoading(true);
      persistState(newUrl, history, newIndex);
    }
  };

  const handleForward = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      const newUrl = history[newIndex];
      setHistoryIndex(newIndex);
      setUrl(newUrl);
      setInputUrl(newUrl);
      setIsLoading(true);
      persistState(newUrl, history, newIndex);
    }
  };

  const handleRefresh = () => {
    setIsLoading(true);
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      if (iframeRef.current && url) {
        iframeRef.current.src = url;
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigateTo(inputUrl);
  };

  // Listen for browser-panel:navigate CustomEvents (e.g., from SelectionPopover)
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{ url: string; sessionId: string }>;
      if (customEvent.detail.sessionId === panel.sessionId) {
        navigateTo(customEvent.detail.url);
      }
    };
    window.addEventListener('browser-panel:navigate', handler);
    return () => window.removeEventListener('browser-panel:navigate', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- navigateTo reads history/historyIndex from closure; re-registering on sessionId change is sufficient
  }, [panel.sessionId]);

  // Suppress unused warning for isActive — kept for API symmetry with other panels
  void isActive;

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Browser chrome */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border-primary bg-bg-chrome flex-shrink-0">
        <button
          onClick={handleBack}
          disabled={historyIndex <= 0}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            historyIndex <= 0 && 'opacity-30 cursor-not-allowed'
          )}
          title="Back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleForward}
          disabled={historyIndex >= history.length - 1}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            historyIndex >= history.length - 1 && 'opacity-30 cursor-not-allowed'
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
        <form onSubmit={handleSubmit} className="flex-1 min-w-0">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => { setInputUrl(e.target.value); setUrlError(''); }}
            placeholder="localhost:3000"
            className={cn(
              'w-full px-2.5 py-1 text-sm rounded bg-bg-input border border-border-primary',
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
        <iframe
          ref={iframeRef}
          src={url}
          className="w-full flex-1 border-0"
          onLoad={() => setIsLoading(false)}
          title="Browser Preview"
        />
      )}
    </div>
  );
};

export default BrowserPanel;
