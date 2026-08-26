import React, { useState, useEffect, useCallback } from 'react';
import { FileEditor } from './FileEditor';
import { ExplorerPanelState, ToolPanel } from '../../../../../shared/types/panels';
import { panelApi } from '../../../services/panelApi';
import { debounce } from '../../../utils/debounce';
import { devLog } from '../../../utils/console';
import { usePanelStore } from '../../../stores/panelStore';

interface ExplorerPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

const ExplorerPanel: React.FC<ExplorerPanelProps> = ({
  panel, 
  isActive 
}) => {
  const [isInitialized, setIsInitialized] = useState(false);
  
  // Extract explorer state each render to ensure we get updates
  const explorerState = React.useMemo(() =>
    // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
    panel.state?.customState as ExplorerPanelState,
    [panel.state?.customState]
  );
  
  devLog.debug('[ExplorerPanel] Rendering with state:', {
    panelId: panel.id,
    isActive,
    explorerState,
    panelState: panel.state
  });
  
  // Mark panel as viewed when it becomes active
  useEffect(() => {
    if (isActive && !panel.state?.hasBeenViewed) {
      panelApi.updatePanel(panel.id, {
        state: {
          ...panel.state,
          hasBeenViewed: true
        }
      });
    }
  }, [isActive, panel.id, panel.state]);
  
  // Initialize the editor panel
  useEffect(() => {
    if (isActive && !isInitialized) {
      setIsInitialized(true);
      // If there's a file path in state, it will be loaded by FileEditor
    }
  }, [isActive, isInitialized]);
  
  const [debouncedUpdate] = useState(() => debounce((panelId: string, sessionId: string, newState: Partial<ExplorerPanelState>) => {
    devLog.debug('[ExplorerPanel] Saving state to database:', {
      panelId,
      newState
    });

    // Get the CURRENT panel state from the store (not stale closure!)
    const panels = usePanelStore.getState().getSessionPanels(sessionId);
    const currentPanel = panels.find(p => p.id === panelId);

    if (!currentPanel) {
      console.error('[ExplorerPanel] Panel not found in store:', panelId);
      return;
    }

    // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
    const currentCustomState = (currentPanel.state?.customState || {}) as ExplorerPanelState;

    const stateToSave = {
      isActive: currentPanel.state?.isActive || false,
      isPinned: currentPanel.state?.isPinned,
      hasBeenViewed: currentPanel.state?.hasBeenViewed,
      customState: {
        ...currentCustomState,  // Merge with existing state
        ...newState             // Apply new state on top
      }
    };

    devLog.debug('[ExplorerPanel] Full state being saved:', stateToSave);

    panelApi.updatePanel(panelId, {
      state: stateToSave
    }).then(() => {
      devLog.debug('[ExplorerPanel] State saved successfully');
    }).catch(err => {
      console.error('[ExplorerPanel] Failed to update explorer panel state:', err);
    });
  }, 500));
  
  // Cleanup effect for debounced function - flush pending saves on unmount
  useEffect(() => {
    return () => {
      if (debouncedUpdate.flush) {
        devLog.debug('[ExplorerPanel] Flushing pending saves on unmount');
        debouncedUpdate.flush(); // Save any pending changes before unmount
      }
    };
  }, [debouncedUpdate]);

  // Also flush pending saves when switching sessions
  useEffect(() => {
    const handleSessionSwitch = () => {
      if (debouncedUpdate.flush) {
        devLog.debug('[ExplorerPanel] Flushing pending saves on session switch');
        debouncedUpdate.flush(); // Save before switching sessions
      }
    };

    window.addEventListener('session-switched', handleSessionSwitch);
    return () => {
      window.removeEventListener('session-switched', handleSessionSwitch);
    };
  }, [debouncedUpdate]);

  // Flush pending saves when panel becomes inactive
  useEffect(() => {
    if (!isActive && debouncedUpdate.flush) {
      devLog.debug('[ExplorerPanel] Panel became inactive, flushing pending saves');
      debouncedUpdate.flush(); // Save immediately when switching away
    }
  }, [debouncedUpdate, isActive]);

  // Save state changes to the panel
  const handleStateChange = useCallback((newState: Partial<ExplorerPanelState>) => {
    devLog.debug('[ExplorerPanel] handleStateChange called with:', newState);

    // Call debounced update - it will fetch fresh state from the store
    devLog.debug('[ExplorerPanel] Calling debounced update');
    debouncedUpdate(panel.id, panel.sessionId, newState);
  }, [debouncedUpdate, panel.id, panel.sessionId]);
  
  // Only render when active. Explorer is cheap to initialize and should not
  // keep Monaco, file tree loading, or git file-status checks alive in the
  // background while the user is working in another panel.
  if (!isActive) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        <div className="text-center">
          <div className="text-sm">Explorer panel not active</div>
          <div className="text-xs mt-1 text-text-tertiary">Click to activate</div>
        </div>
      </div>
    );
  }
  
  return (
    <div className="h-full w-full">
      <FileEditor
        sessionId={panel.sessionId}
        initialState={explorerState}
        onStateChange={handleStateChange}
      />
    </div>
  );
};

export default ExplorerPanel;
