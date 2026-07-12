import { useEffect, useCallback, useState } from 'react';
import { Play, Square, Loader2, Cloud, Monitor, Terminal } from 'lucide-react';
import { createDefaultCloudVmState } from '../../../shared/types/cloud';
import { useCloudStore } from '../stores/cloudStore';
import { useSessionStore } from '../stores/sessionStore';
import { openCloudSetupTerminal } from '../services/cloudSetupTerminal';

const DEFAULT_CLOUD_STATE = createDefaultCloudVmState();

export function CloudWidget() {
  const { vmState, showCloudView, loading, setVmState, setLoading, setShowCloudView, toggleCloudView } = useCloudStore();
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const [setupLoading, setSetupLoading] = useState(false);

  // Initialize: fetch state, start polling, subscribe to changes
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    async function init() {
      try {
        const result = await window.electronAPI.cloud.getState();
        if (result.success && result.data) {
          setVmState(result.data);
        }

        await window.electronAPI.cloud.startPolling();

        cleanup = window.electronAPI.cloud.onStateChanged((newState) => {
          setVmState(newState);
          setLoading(false);
        });
      } catch {
        // Cloud not configured
      }
    }

    init();

    return () => {
      cleanup?.();
      window.electronAPI?.cloud?.stopPolling().catch(() => {});
    };
  }, [setVmState, setLoading]);

  // When VM explicitly stops, exit cloud view (but not on transient 'unknown' status)
  useEffect(() => {
    const explicitlyOff = vmState && (vmState.status === 'off' || vmState.status === 'stopping' || vmState.status === 'not_provisioned');
    if (explicitlyOff && showCloudView) {
      setShowCloudView(false);
    }
  }, [vmState, showCloudView, setShowCloudView]);

  const handleStart = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.cloud.startVm();
      if (result.success && result.data) {
        setVmState(result.data);
      }
    } catch (err) {
      setVmState({
        ...(vmState ?? DEFAULT_CLOUD_STATE),
        error: err instanceof Error ? err.message : 'Failed to start VM',
        status: 'unknown',
      });
    } finally {
      setLoading(false);
    }
  }, [setLoading, setVmState, vmState]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    setShowCloudView(false);
    try {
      const result = await window.electronAPI.cloud.stopVm();
      if (result.success && result.data) {
        setVmState(result.data);
      }
    } catch (err) {
      setVmState({
        ...(vmState ?? DEFAULT_CLOUD_STATE),
        error: err instanceof Error ? err.message : 'Failed to stop VM',
        status: 'unknown',
      });
    } finally {
      setLoading(false);
    }
  }, [setLoading, setShowCloudView, setVmState, vmState]);

  const handleConnectWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.cloud.connectWorkspace();
      if (result.success && result.data) {
        setVmState(result.data);
        return;
      }

      setVmState({
        ...(vmState ?? DEFAULT_CLOUD_STATE),
        error: result.error ?? 'Failed to connect to hosted workspace',
      });
    } catch (err) {
      setVmState({
        ...(vmState ?? DEFAULT_CLOUD_STATE),
        error: err instanceof Error ? err.message : 'Failed to connect to hosted workspace',
      });
    } finally {
      setLoading(false);
    }
  }, [setLoading, setVmState, vmState]);

  const handleDisconnectWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.cloud.disconnectWorkspace();
      if (result.success && result.data) {
        setVmState(result.data);
        return;
      }

      setVmState({
        ...(vmState ?? DEFAULT_CLOUD_STATE),
        error: result.error ?? 'Failed to switch back to local runtime',
      });
    } catch (err) {
      setVmState({
        ...(vmState ?? DEFAULT_CLOUD_STATE),
        error: err instanceof Error ? err.message : 'Failed to switch back to local runtime',
      });
    } finally {
      setLoading(false);
    }
  }, [setLoading, setVmState, vmState]);

  const handleOpenSetupTerminal = useCallback(async () => {
    if (!activeSessionId) {
      setVmState({
        ...(vmState ?? DEFAULT_CLOUD_STATE),
        error: 'Select a session first to open the setup terminal',
      });
      return;
    }

    setSetupLoading(true);
    try {
      await openCloudSetupTerminal(activeSessionId);
    } catch (err) {
      console.error('[CloudWidget] Failed to create setup terminal:', err);
    } finally {
      setSetupLoading(false);
    }
  }, [activeSessionId, setVmState, vmState]);

  // Hide widget entirely if cloud is not provisioned — only show once user
  // has configured cloud through Settings
  if (!vmState || vmState.status === 'not_provisioned') {
    return null;
  }

  const isTransitioning = vmState.status === 'starting' || vmState.status === 'stopping' || vmState.status === 'initializing';
  const isRunning = vmState.status === 'running';
  const isOff = vmState.status === 'off';
  const isUnknown = vmState.status === 'unknown'; // Usually means auth failed
  const hasDaemonMetadata = Boolean(
    vmState.daemonBaseUrl
    || vmState.linkedRemoteProfileId
    || vmState.daemonStatus !== 'unknown',
  );
  const noVncFallbackReady = vmState.allowNoVncFallback && Boolean(vmState.noVncUrl);
  const daemonUnavailableWithFallback =
    noVncFallbackReady &&
    (vmState.daemonStatus === 'unknown' || vmState.daemonStatus === 'error');
  const daemonAccess =
    isRunning &&
    vmState.preferredAccess === 'daemon' &&
    hasDaemonMetadata &&
    !daemonUnavailableWithFallback;
  const daemonBootstrapping = daemonAccess && vmState.daemonStatus === 'bootstrapping';
  const daemonReady = daemonAccess && vmState.daemonStatus === 'ready';
  const daemonConnected = daemonReady && vmState.remoteConnectionStatus === 'connected';
  const daemonConnectAvailable = daemonReady && vmState.remoteConnectionStatus === 'available';
  const daemonConnectionReconnecting =
    daemonReady &&
    (vmState.remoteConnectionStatus === 'connecting' || vmState.remoteConnectionStatus === 'reconnecting');
  const daemonConnectionError = daemonReady && vmState.remoteConnectionStatus === 'error';
  const daemonConnectionUnavailable = daemonConnectionReconnecting || daemonConnectionError;
  const daemonError = daemonAccess && vmState.daemonStatus === 'error';
  const canManageCloudVmLifecycle = isRunning && vmState.noVncUrl !== null;
  const tunnelConnecting = isRunning && !daemonAccess && vmState.tunnelStatus === 'starting';
  const tunnelReady = isRunning && !daemonAccess && vmState.tunnelStatus === 'running';
  const tunnelError = isRunning && !daemonAccess && vmState.tunnelStatus === 'error';
  const tunnelDisconnected = isRunning && !daemonAccess && vmState.tunnelStatus === 'off';

  // Show reconnect button for: tunnel issues OR unknown status (auth failed)
  const needsReconnect = (daemonError || tunnelError || tunnelDisconnected || isUnknown) && !loading && activeSessionId;

  // Compute transitioning label
  const getTransitionLabel = () => {
    if (vmState.status === 'stopping') return 'Stopping...';
    if (vmState.status === 'starting' || vmState.status === 'initializing') return 'Starting VM...';
    if (daemonBootstrapping) return 'Starting workspace daemon...';
    if (daemonConnectionReconnecting) {
      return vmState.remoteConnectionStatus === 'connecting'
        ? 'Connecting cloud runtime...'
        : 'Reconnecting cloud runtime...';
    }
    if (tunnelConnecting) return 'Connecting tunnel...';
    return 'Loading...';
  };

  return (
    <div className="fixed bottom-4 right-4 flex items-center gap-1.5" style={{ zIndex: 1300 }}>
      {/* Error tooltip */}
      {vmState.error && (
        <div
          className="px-2 py-1 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400 max-w-72"
          title={vmState.error}
        >
          <span className="line-clamp-2">{vmState.error}</span>
        </div>
      )}

      {/* Transitioning state (VM starting/stopping or tunnel connecting) */}
      {(isTransitioning || daemonBootstrapping || daemonConnectionReconnecting || tunnelConnecting || loading) && (
        <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg">
          <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />
          <span className="text-xs text-text-secondary">
            {getTransitionLabel()}
          </span>
        </div>
      )}

      {/* Off state — start button */}
      {isOff && !loading && (
        <button
          onClick={handleStart}
          className="flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
          title="Start Cloud VM"
        >
          <Play className="w-4 h-4 text-green-400 fill-green-400" />
          <span className="text-xs text-text-primary">Start Cloud</span>
        </button>
      )}

      {/* Tunnel disconnected, error, or unknown status — show reconnect (opens setup script which handles auth + tunnel) */}
      {needsReconnect && (
        <>
          {/* Only show stop button if VM is confirmed running */}
          {canManageCloudVmLifecycle && (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 px-2.5 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
              title="Stop Cloud VM"
            >
              <Square className="w-3.5 h-3.5 text-red-400 fill-red-400" />
            </button>
          )}
          <button
            onClick={handleOpenSetupTerminal}
            disabled={setupLoading}
            className={`flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors disabled:opacity-50 ${
              tunnelError || isUnknown ? 'border-orange-500/30' : 'border-border-primary'
            }`}
            title="Open terminal to reconnect (handles authentication)"
          >
            {setupLoading ? (
              <Loader2 className="w-4 h-4 animate-spin text-interactive" />
            ) : (
              <Terminal className={`w-4 h-4 ${tunnelError || isUnknown ? 'text-orange-400' : 'text-green-400'}`} />
            )}
            <span className="text-xs text-text-primary">Reconnect</span>
          </button>
        </>
      )}

      {/* Running state with tunnel ready — stop + toggle */}
      {tunnelReady && !loading && (
        <>
          <button
            onClick={handleStop}
            className="flex items-center gap-1.5 px-2.5 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
            title="Stop Cloud VM"
          >
            <Square className="w-3.5 h-3.5 text-red-400 fill-red-400" />
          </button>
          <button
            onClick={toggleCloudView}
            className={`flex items-center gap-2 px-3 py-2 backdrop-blur-sm border rounded-xl shadow-lg transition-colors ${
              showCloudView
                ? 'bg-interactive/10 border-interactive/40 hover:bg-interactive/20'
                : 'bg-bg-secondary/95 border-border-primary hover:bg-bg-tertiary'
            }`}
            title={showCloudView ? 'Switch to Local' : 'Switch to Cloud'}
          >
            {showCloudView ? (
              <>
                <Monitor className="w-4 h-4 text-text-primary" />
                <span className="text-xs text-text-primary">Local</span>
              </>
            ) : (
              <>
                <Cloud className="w-4 h-4 text-interactive" />
                <span className="text-xs text-text-primary">Cloud</span>
              </>
            )}
          </button>
        </>
      )}

      {daemonConnectAvailable && !loading && (
        <>
          {canManageCloudVmLifecycle && (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 px-2.5 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
              title="Stop Cloud VM"
            >
              <Square className="w-3.5 h-3.5 text-red-400 fill-red-400" />
            </button>
          )}
          <button
            onClick={handleConnectWorkspace}
            className="flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
            title="Connect to hosted workspace daemon"
          >
            <Cloud className="w-4 h-4 text-interactive" />
            <span className="text-xs text-text-primary">Connect Cloud</span>
          </button>
        </>
      )}

      {daemonConnected && !loading && (
        <>
          {canManageCloudVmLifecycle && (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 px-2.5 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
              title="Stop Cloud VM"
            >
              <Square className="w-3.5 h-3.5 text-red-400 fill-red-400" />
            </button>
          )}
          <button
            onClick={handleDisconnectWorkspace}
            className="flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
            title="Switch back to local runtime"
          >
            <Monitor className="w-4 h-4 text-text-primary" />
            <span className="text-xs text-text-primary">Use Local Runtime</span>
          </button>
          <div
            className="flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg"
            title="Hosted workspace daemon is connected"
          >
            <Cloud className="w-4 h-4 text-interactive" />
            <span className="text-xs text-text-primary">Cloud Connected</span>
          </div>
        </>
      )}

      {daemonConnectionUnavailable && !loading && (
        <>
          <button
            onClick={handleDisconnectWorkspace}
            className="flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
            title="Switch back to local runtime"
          >
            <Monitor className="w-4 h-4 text-text-primary" />
            <span className="text-xs text-text-primary">Use Local Runtime</span>
          </button>
          <div
            className={`flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border rounded-xl shadow-lg ${
              daemonConnectionError ? 'border-red-500/30' : 'border-yellow-500/30'
            }`}
            title={daemonConnectionError
              ? 'Hosted workspace daemon connection failed'
              : 'Hosted workspace daemon is reconnecting'}
          >
            <Cloud className={`w-4 h-4 ${daemonConnectionError ? 'text-red-400' : 'text-yellow-400'}`} />
            <span className="text-xs text-text-primary">
              {daemonConnectionError ? 'Cloud Connection Error' : 'Cloud Reconnecting'}
            </span>
          </div>
        </>
      )}

      {daemonReady && !daemonConnectAvailable && !daemonConnected && !daemonConnectionUnavailable && !loading && (
        <>
          {canManageCloudVmLifecycle && (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 px-2.5 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg hover:bg-bg-tertiary transition-colors"
              title="Stop Cloud VM"
            >
              <Square className="w-3.5 h-3.5 text-red-400 fill-red-400" />
            </button>
          )}
          <div
            className="flex items-center gap-2 px-3 py-2 bg-bg-secondary/95 backdrop-blur-sm border border-border-primary rounded-xl shadow-lg"
            title="Hosted workspace daemon is ready"
          >
            <Cloud className="w-4 h-4 text-interactive" />
            <span className="text-xs text-text-primary">Daemon Ready</span>
          </div>
        </>
      )}
    </div>
  );
}
