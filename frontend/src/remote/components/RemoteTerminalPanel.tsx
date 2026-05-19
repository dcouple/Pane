import type { ToolPanel } from '../../../../shared/types/panels';
import type { RemotePaneConnectionStatus, RemotePwaTerminalShortcut } from '../../../../shared/types/remoteDaemon';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import { useRemoteTerminal } from '../hooks/useRemoteTerminal';
import { RemoteTerminalInputBar } from './RemoteTerminalInputBar';

interface RemoteTerminalPanelProps {
  adapter: RemoteRuntimeAdapter;
  panel: ToolPanel;
  sessionId: string;
  connectionStatus: RemotePaneConnectionStatus;
  shortcuts: RemotePwaTerminalShortcut[];
  shortcutsLoading?: boolean;
  onRefreshShortcuts: () => void;
}

export function RemoteTerminalPanel({
  adapter,
  panel,
  sessionId,
  connectionStatus,
  shortcuts,
  shortcutsLoading = false,
  onRefreshShortcuts,
}: RemoteTerminalPanelProps) {
  const { containerRef, statusText, focusTerminal, resetTerminal } = useRemoteTerminal({
    adapter,
    panel,
    sessionId,
    connectionStatus,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#010409]">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full overflow-hidden p-2" />
        {statusText !== 'Connected' && (
          <div className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
            {statusText}
          </div>
        )}
      </div>
      <RemoteTerminalInputBar
        shortcuts={shortcuts}
        shortcutsLoading={shortcutsLoading}
        disabled={connectionStatus !== 'connected'}
        onOpenShortcuts={onRefreshShortcuts}
        onResetTerminal={resetTerminal}
        onSendInput={(data) => {
          void adapter.sendTerminalInput(panel.id, data)
            .then(() => {
              window.requestAnimationFrame(focusTerminal);
            })
            .catch(() => {});
        }}
      />
    </div>
  );
}
