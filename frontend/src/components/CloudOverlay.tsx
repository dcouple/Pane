import { useState, useEffect } from 'react';
import { useCloudStore } from '../stores/cloudStore';

/**
 * Full-screen iframe overlay for noVNC cloud desktop.
 * The iframe stays mounted (hidden via CSS) to persist the VNC session
 * when the user toggles back to local view.
 */
export function CloudOverlay() {
  const { vmState, showCloudView, iframeReady, setIframeReady } = useCloudStore();
  const [hasEverBeenRunning, setHasEverBeenRunning] = useState(false);

  // Once the VM is running and the user opens cloud view, mount the iframe permanently
  useEffect(() => {
    if (vmState?.status === 'running' && showCloudView && !hasEverBeenRunning) {
      setHasEverBeenRunning(true);
    }
  }, [vmState?.status, showCloudView, hasEverBeenRunning]);

  // Reset when VM stops
  useEffect(() => {
    if (vmState && vmState.status !== 'running' && vmState.status !== 'starting' && vmState.status !== 'initializing') {
      setHasEverBeenRunning(false);
    }
  }, [vmState?.status]);

  const noVncUrl = vmState?.noVncUrl;

  // Don't render anything until we have a URL and the user has toggled to cloud at least once
  if (!hasEverBeenRunning || !noVncUrl) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-sticky bg-black"
      style={{ display: showCloudView ? 'block' : 'none' }}
    >
      {!iframeReady && (
        <div className="absolute inset-0 bg-bg-primary animate-pulse">
          <div className="h-full flex flex-col">
            {/* Top bar skeleton */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border-primary">
              <div className="h-4 w-32 bg-surface-tertiary rounded" />
              <div className="h-4 w-4 bg-surface-tertiary rounded" />
            </div>
            {/* Content area skeleton */}
            <div className="flex-1 p-6 space-y-4">
              <div className="h-6 w-64 bg-surface-tertiary rounded" />
              <div className="h-4 w-full bg-surface-tertiary rounded" />
              <div className="h-4 w-3/4 bg-surface-tertiary rounded" />
              <div className="h-64 w-full bg-surface-tertiary rounded-lg" />
            </div>
          </div>
        </div>
      )}
      <iframe
        key={noVncUrl}
        src={noVncUrl}
        className="w-full h-full border-none"
        title="Pane Cloud Desktop"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onLoad={() => {
          if (!iframeReady) {
            setIframeReady();
          }
        }}
      />
    </div>
  );
}
