import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';
import { API } from '../utils/api';
import type { Session } from '../types/session';
import type { PaneChatAgent, PaneChatState } from '../../../shared/types/paneChat';
import { SessionProvider } from '../contexts/SessionContext';
import { PanelContainer } from './panels/PanelContainer';
import { Button } from './ui/Button';
import { ClaudeIcon, CursorIcon, OpenAIIcon } from './ui/BrandIcons';
import { cn } from '../utils/cn';
import { LiveRegion } from './ui/LiveRegion';
import { visibleAgentPresets } from '../utils/agentPresets';

const ALL_PANE_CHAT_AGENT_OPTIONS: Array<{
  id: PaneChatAgent;
  label: string;
  icon: typeof ClaudeIcon;
}> = [
  { id: 'claude', label: 'Claude', icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', icon: OpenAIIcon },
  { id: 'cursor', label: 'Cursor', icon: CursorIcon },
];

const visiblePaneChatAgents = new Set(visibleAgentPresets().map(preset => preset.id));
const PANE_CHAT_AGENT_OPTIONS = ALL_PANE_CHAT_AGENT_OPTIONS.filter(option => visiblePaneChatAgents.has(option.id));

const PANE_CHAT_AGENT_LABELS: Record<PaneChatAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

export function PaneChatView() {
  const [state, setState] = useState<PaneChatState<Session> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [switchingAgent, setSwitchingAgent] = useState<PaneChatAgent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');

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

  const handleAgentChange = useCallback(async (agent: PaneChatAgent) => {
    if (!state || state.agent === agent || switchingAgent) {
      return;
    }

    setSwitchingAgent(agent);
    setError(null);
    setStatusAnnouncement(`Switching Pane Chat to ${PANE_CHAT_AGENT_LABELS[agent]}`);

    try {
      const response = await API.paneChat.setAgent(agent);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to switch Pane Chat agent');
      }
      setState(response.data);
      setStatusAnnouncement(`Pane Chat is now using ${PANE_CHAT_AGENT_LABELS[agent]}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch Pane Chat agent');
    } finally {
      setSwitchingAgent(null);
    }
  }, [state, switchingAgent]);

  if (isLoading && !state) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary text-text-secondary">
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
          <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" />
          <span>Opening Pane Chat...</span>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary p-6">
        <div className="max-w-md text-center">
          <Terminal className="mx-auto mb-3 h-8 w-8 text-text-tertiary" />
          <h2 className="text-base font-semibold text-text-primary">Pane Chat did not open</h2>
          <p role="alert" className="mt-2 text-sm text-text-secondary">{error ?? 'Unknown error'}</p>
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
      <LiveRegion>{statusAnnouncement}</LiveRegion>
      <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border-primary px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
          <h1 className="truncate text-sm font-semibold text-text-primary">Pane Chat</h1>
          {error && (
            <span role="alert" className="truncate text-xs text-status-error">{error}</span>
          )}
        </div>
        <fieldset
          className="flex h-8 flex-shrink-0 items-center rounded-md border border-border-secondary bg-surface-secondary p-0.5"
        >
          <legend className="sr-only">Pane Chat agent</legend>
          {PANE_CHAT_AGENT_OPTIONS.map((option) => {
            const Icon = switchingAgent === option.id ? RefreshCw : option.icon;
            const selected = state.agent === option.id;

            return (
              <label
                key={option.id}
                className={cn(
                  'relative inline-flex h-7 min-w-[76px] cursor-pointer items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-interactive',
                  switchingAgent !== null && 'cursor-not-allowed opacity-70',
                  selected
                    ? 'bg-bg-primary text-text-primary shadow-sm'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                )}
              >
                <input
                  type="radio"
                  name="pane-chat-agent"
                  value={option.id}
                  checked={selected}
                  aria-disabled={switchingAgent !== null || undefined}
                  onChange={() => void handleAgentChange(option.id)}
                  className="sr-only"
                />
                <Icon className={cn('h-3.5 w-3.5', switchingAgent === option.id && 'animate-spin')} />
                <span>{option.label}</span>
              </label>
            );
          })}
        </fieldset>
      </div>

      <SessionProvider session={state.session}>
        <div className="min-h-0 flex-1 overflow-hidden">
          <PanelContainer panel={state.panel} isActive={true} autoFocus={true} />
        </div>
      </SessionProvider>
    </div>
  );
}
