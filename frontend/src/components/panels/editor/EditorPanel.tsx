import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FileEditor } from './FileEditor';
import { ExplorerPanelState, ToolPanel } from '../../../../../shared/types/panels';
import { panelApi } from '../../../services/panelApi';
import { debounce, type DebouncedFunction } from '../../../utils/debounce';
import { usePanelStore } from '../../../stores/panelStore';

interface ExplorerPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

export const ExplorerPanel: React.FC<ExplorerPanelProps> = ({ 
  panel, 
  isActive 
}) => {
  const [isInitialized, setIsInitialized] = useState(false);
  
  // Extract explorer state each render to ensure we get updates
  const explorerState = React.useMemo(() =>
    panel.state?.customState as ExplorerPanelState,
    [panel.state?.customState]
  );
  
  console.log('[ExplorerPanel] Rendering with state:', {
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
  
  // Use ref to store the debounced function so it doesn't get recreated
  const debouncedUpdateRef = useRef<DebouncedFunction<(panelId: string, sessionId: string, newState: Partial<ExplorerPanelState>) => void> | null>(null);

  // Initialize debounced function immediately to prevent warning
  if (!debouncedUpdateRef.current) {
    debouncedUpdateRef.current = debounce((panelId: string, sessionId: string, newState: Partial<ExplorerPanelState>) => {
      console.log('[ExplorerPanel] Saving state to database:', {
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

      console.log('[ExplorerPanel] Full state being saved:', stateToSave);

      panelApi.updatePanel(panelId, {
        state: stateToSave
      }).then(() => {
        console.log('[ExplorerPanel] State saved successfully');
      }).catch(err => {
        console.error('[ExplorerPanel] Failed to update explorer panel state:', err);
      });
    }, 500);
  }
  
  // Cleanup effect for debounced function - flush pending saves on unmount
  useEffect(() => {
    return () => {
      if (debouncedUpdateRef.current?.flush) {
        console.log('[ExplorerPanel] Flushing pending saves on unmount');
        debouncedUpdateRef.current.flush(); // Save any pending changes before unmount
      }
    };
  }, []); // Empty deps - only create once

  // Also flush pending saves when switching sessions
  useEffect(() => {
    const handleSessionSwitch = () => {
      if (debouncedUpdateRef.current?.flush) {
        console.log('[ExplorerPanel] Flushing pending saves on session switch');
        debouncedUpdateRef.current.flush(); // Save before switching sessions
      }
    };

    window.addEventListener('session-switched', handleSessionSwitch);
    return () => {
      window.removeEventListener('session-switched', handleSessionSwitch);
    };
  }, []); // Empty deps - only create once

  // Flush pending saves when panel becomes inactive
  useEffect(() => {
    if (!isActive && debouncedUpdateRef.current?.flush) {
      console.log('[ExplorerPanel] Panel became inactive, flushing pending saves');
      debouncedUpdateRef.current.flush(); // Save immediately when switching away
    }
  }, [isActive]);

  // Save state changes to the panel
  const handleStateChange = useCallback((newState: Partial<ExplorerPanelState>) => {
    console.log('[ExplorerPanel] handleStateChange called with:', newState);

    // Call debounced update - it will fetch fresh state from the store
    if (debouncedUpdateRef.current) {
      console.log('[ExplorerPanel] Calling debounced update');
      debouncedUpdateRef.current(panel.id, panel.sessionId, newState);
    } else {
      console.error('[ExplorerPanel] No debounced update function!');
    }
  }, [panel.id, panel.sessionId]);
  
  // Update panel title when file changes
  const handleFileChange = useCallback((filePath: string | undefined, isDirty: boolean) => {
    if (filePath) {
      const filename = filePath.split('/').pop() || 'Explorer';
      const title = isDirty ? `${filename} *` : filename;
      panelApi.updatePanel(panel.id, { title });
      
      // Also update state
      handleStateChange({ filePath, isDirty });
    }
  }, [panel.id, handleStateChange]);
  
  return (
    <div className="h-full w-full">
      <FileEditor
        sessionId={panel.sessionId}
        initialFilePath={explorerState?.filePath}
        initialState={explorerState}
        onFileChange={handleFileChange}
        onStateChange={handleStateChange}
      />
    </div>
  );
};

export default ExplorerPanel;
