import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';
import { API } from '../utils/api';
import type { Session } from '../types/session';
import type { PaneChatState } from '../../../shared/types/paneChat';
import { SessionProvider } from '../contexts/SessionContext';
import { PanelContainer } from './panels/PanelContainer';
import { Button } from './ui/Button';
import { ClaudeIcon, OpenAIIcon } from './ui/BrandIcons';

export function PaneChatView() {
  const [state, setState] = useState<PaneChatState<Session> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPaneChat = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await API.paneChat.getOrCreate();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to open Pane Chat');
      }
      setState(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open Pane Chat');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPaneChat();
  }, [loadPaneChat]);

  const AgentIcon = state?.agent === 'codex' ? OpenAIIcon : ClaudeIcon;

  if (isLoading && !state) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary text-text-secondary">
        <div className="flex items-center gap-2 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>Opening Pane Chat...</span>
        </div>
      </div>
    );
  }

  if (error || !state) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary p-6">
        <div className="max-w-md text-center">
          <Terminal className="mx-auto mb-3 h-8 w-8 text-text-tertiary" />
          <h2 className="text-base font-semibold text-text-primary">Pane Chat did not open</h2>
          <p className="mt-2 text-sm text-text-secondary">{error ?? 'Unknown error'}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4"
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={loadPaneChat}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pane-chat-shell flex-1 flex flex-col overflow-hidden bg-bg-primary">
      <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border-primary px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
          <h1 className="truncate text-sm font-semibold text-text-primary">Pane Chat</h1>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border-secondary bg-surface-secondary px-2 py-1 text-xs text-text-secondary">
          <AgentIcon className="h-3.5 w-3.5" />
          <span>{state.agent === 'codex' ? 'Codex' : 'Claude'}</span>
        </div>
      </div>

      <SessionProvider session={state.session}>
        <div className="min-h-0 flex-1 overflow-hidden">
          <PanelContainer panel={state.panel} isActive={true} autoFocus={true} />
        </div>
      </SessionProvider>
    </div>
  );
}
