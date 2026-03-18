import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { API } from '../utils/api';
import { useSessionStore } from '../stores/sessionStore';
import { Session } from '../types/session';
import { PanelTabBar } from './panels/PanelTabBar';
import { PanelContainer } from './panels/PanelContainer';
import { usePanelStore } from '../stores/panelStore';
import { panelApi } from '../services/panelApi';
import { ToolPanel, ToolPanelType } from '../../../shared/types/panels';
import { PanelCreateOptions } from '../types/panelComponents';
import { SessionProvider } from '../contexts/SessionContext';
import { DetailPanel } from './DetailPanel';
import { useResizable } from '../hooks/useResizable';

interface ProjectViewProps {
  projectId: number;
  projectName: string;
  onGitPull: () => void;
  onGitPush: () => void;
  isMerging: boolean;
}

export const ProjectView: React.FC<ProjectViewProps> = ({ 
  projectId, 
  projectName, 
  onGitPull, 
  onGitPush, 
  isMerging
}) => {
  const [mainRepoSessionId, setMainRepoSessionId] = useState<string | null>(null);
  const [mainRepoSession, setMainRepoSession] = useState<Session | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  // Panel store state and actions
  const {
    panels,
    activePanels,
    setPanels,
    setActivePanel: setActivePanelInStore,
    addPanel,
    removePanel
  } = usePanelStore();

  // Detail panel state
  const [detailVisible, setDetailVisible] = useState(() => {
    const stored = localStorage.getItem('pane-project-detail-panel-visible');
    return stored !== null ? stored === 'true' : true;
  });

  // Persist detail panel visibility
  useEffect(() => {
    localStorage.setItem('pane-project-detail-panel-visible', String(detailVisible));
  }, [detailVisible]);

  // Right-side resizable
  const { width: detailWidth, startResize: startDetailResize } = useResizable({
    defaultWidth: 320,
    minWidth: 200,
    maxWidth: 500,
    storageKey: 'pane-project-detail-panel-width',
    side: 'right'
  });

  // Load panels when main repo session changes (no auto-creation, matches worktree session behavior)
  useEffect(() => {
    if (mainRepoSessionId) {
      console.log('[ProjectView] Loading panels for project session:', mainRepoSessionId);
      panelApi.loadPanelsForSession(mainRepoSessionId).then(async (loadedPanels) => {
        console.log('[ProjectView] Loaded panels:', loadedPanels);

        setPanels(mainRepoSessionId, loadedPanels);

        // Pick default active: prefer explorer, then diff, then first panel
        const fallback = loadedPanels.find(p => p.type === 'explorer')
          || loadedPanels.find(p => p.type === 'diff')
          || loadedPanels[0];

        const activePanel = await panelApi.getActivePanel(mainRepoSessionId);
        if (activePanel) {
          setActivePanelInStore(mainRepoSessionId, activePanel.id);
        } else if (fallback) {
          setActivePanelInStore(mainRepoSessionId, fallback.id);
          await panelApi.setActivePanel(mainRepoSessionId, fallback.id);
        }
      });
    }
  }, [mainRepoSessionId, setPanels, setActivePanelInStore]);
  
  // Get panels for current main repo session
  const sessionPanels = useMemo(
    () => panels[mainRepoSessionId || ''] || [],
    [panels, mainRepoSessionId]
  );

  const currentActivePanel = useMemo(
    () => sessionPanels.find(p => p.id === activePanels[mainRepoSessionId || '']),
    [sessionPanels, activePanels, mainRepoSessionId]
  );
  
  // Panel event handlers
  const handlePanelSelect = useCallback(
    async (panel: ToolPanel) => {
      if (!mainRepoSessionId) return;
      setActivePanelInStore(mainRepoSessionId, panel.id);
      await panelApi.setActivePanel(mainRepoSessionId, panel.id);
    },
    [mainRepoSessionId, setActivePanelInStore]
  );

  const handlePanelClose = useCallback(
    async (panel: ToolPanel) => {
      if (!mainRepoSessionId) return;

      // Find next panel to activate
      const panelIndex = sessionPanels.findIndex(p => p.id === panel.id);
      const nextPanel = sessionPanels[panelIndex + 1] || sessionPanels[panelIndex - 1];

      // Remove from store first for immediate UI update
      removePanel(mainRepoSessionId, panel.id);

      // Set next active panel if available
      if (nextPanel) {
        setActivePanelInStore(mainRepoSessionId, nextPanel.id);
        await panelApi.setActivePanel(mainRepoSessionId, nextPanel.id);
      }

      // Delete on backend
      await panelApi.deletePanel(panel.id);
    },
    [mainRepoSessionId, sessionPanels, removePanel, setActivePanelInStore]
  );

  const handlePanelCreate = useCallback(
    async (type: ToolPanelType, options?: PanelCreateOptions) => {
      if (!mainRepoSessionId) return;

      // For terminal panels with initialCommand (e.g., Terminal (Claude))
      let initialState: { customState?: unknown } | undefined = undefined;
      if (type === 'terminal' && options?.initialCommand) {
        initialState = {
          customState: {
            initialCommand: options.initialCommand
          }
        };
      }

      const newPanel = await panelApi.createPanel({
        sessionId: mainRepoSessionId,
        type,
        title: options?.title,
        initialState
      });

      // Immediately add the panel and set it as active
      // The panel:created event will also fire, but addPanel checks for duplicates
      addPanel(newPanel);
      setActivePanelInStore(mainRepoSessionId, newPanel.id);
    },
    [mainRepoSessionId, addPanel, setActivePanelInStore]
  );
  
  // Wrapped git operations - just call the handlers directly without navigating to a panel
  const handleGitPull = useCallback(() => {
    onGitPull();
  }, [onGitPull]);

  const handleGitPush = useCallback(() => {
    onGitPush();
  }, [onGitPush]);
  
  // We don't need terminal handling or the hook for now, as panels handle their own terminals
  
  // Debug logging
  useEffect(() => {
    console.log('[ProjectView] Session state:', { 
      mainRepoSessionId, 
      mainRepoSession: mainRepoSession?.id,
      activePanelType: currentActivePanel?.type,
      activeSessionInStore: useSessionStore.getState().activeSessionId
    });
  }, [mainRepoSessionId, mainRepoSession, currentActivePanel]);

  // Get or create main repo session when panels are needed
  useEffect(() => {
    // Create main repo session when component mounts to support panels
    const getMainRepoSession = async () => {
      setIsLoadingSession(true);
      try {
        const response = await API.sessions.getOrCreateMainRepoSession(projectId);
        if (response.success && response.data) {
          setMainRepoSessionId(response.data.id);
          setMainRepoSession(response.data);
          
          // Subscribe to session updates
          const sessions = useSessionStore.getState().sessions;
          const mainSession = sessions.find(s => s.id === response.data.id);
          if (mainSession) {
            setMainRepoSession(mainSession);
          }
          
          // Set as active session
          useSessionStore.getState().setActiveSession(response.data.id);
        }
      } catch (error) {
        console.error('Failed to get main repo session:', error);
      } finally {
        setIsLoadingSession(false);
      }
    };

    getMainRepoSession();
  }, [projectId]);
  
  // Subscribe to session updates - optimized to check for actual changes
  useEffect(() => {
    if (!mainRepoSessionId) return;
    
    let previousSession = useSessionStore.getState().sessions.find(s => s.id === mainRepoSessionId);
    const unsubscribe = useSessionStore.subscribe((state) => {
      const session = state.sessions.find(s => s.id === mainRepoSessionId);
      // Only update if session actually changed
      if (session && session !== previousSession) {
        previousSession = session;
        setMainRepoSession(session);
      }
    });
    
    return unsubscribe;
  }, [mainRepoSessionId]);

  // Listen for panel updates from the backend
  useEffect(() => {
    if (!mainRepoSessionId) return;

    // Handle panel creation events (for auto-created panels like logs)
    const handlePanelCreated = (panel: ToolPanel) => {
      console.log('[ProjectView] Received panel:created event:', panel);

      // Only add if it's for the current session
      if (panel.sessionId === mainRepoSessionId) {
        // The store's addPanel now checks for duplicates, so we can safely call it
        addPanel(panel);
      }
    };

    // Listen for panel events
    const unsubscribeCreated = window.electronAPI?.events?.onPanelCreated?.(handlePanelCreated);

    // Cleanup
    return () => {
      unsubscribeCreated?.();
    };
  }, [mainRepoSessionId, addPanel]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
      {/* SINGLE SessionProvider wraps everything */}
      {mainRepoSessionId && (
        <SessionProvider session={mainRepoSession} projectName={projectName}>
          {/* Tab bar at top */}
          <PanelTabBar
            panels={sessionPanels}
            activePanel={currentActivePanel}
            onPanelSelect={handlePanelSelect}
            onPanelClose={handlePanelClose}
            onPanelCreate={handlePanelCreate}
            context="project"
            onToggleDetailPanel={() => setDetailVisible(v => !v)}
            detailPanelVisible={detailVisible}
          />

          {/* Content area: center panels + right detail */}
          <div className="flex-1 flex flex-row min-h-0">
            {/* Center: panel content */}
            <div className="flex-1 relative min-h-0 overflow-hidden">
              {isLoadingSession ? (
                <div className="h-full animate-pulse">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-primary bg-surface-secondary">
                    <div className="h-3 w-28 bg-surface-tertiary rounded" />
                    <div className="flex items-center gap-2">
                      <div className="h-3.5 w-3.5 bg-surface-tertiary rounded" />
                      <div className="h-3.5 w-3.5 bg-surface-tertiary rounded" />
                    </div>
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="h-4 w-40 bg-surface-tertiary rounded" />
                    <div className="h-3 w-full bg-surface-tertiary rounded" />
                    <div className="h-3 w-3/4 bg-surface-tertiary rounded" />
                    <div className="h-3 w-5/6 bg-surface-tertiary rounded" />
                    <div className="h-3 w-2/3 bg-surface-tertiary rounded" />
                  </div>
                </div>
              ) : sessionPanels.length > 0 && currentActivePanel ? (
                sessionPanels.map(panel => {
                  const isActive = panel.id === currentActivePanel.id;
                  return (
                    <div
                      key={panel.id}
                      className="absolute inset-0"
                      style={{
                        display: isActive ? 'block' : 'none',
                        pointerEvents: isActive ? 'auto' : 'none'
                      }}
                    >
                      <PanelContainer
                        panel={panel}
                        isActive={isActive}
                        isMainRepo={!!mainRepoSession?.isMainRepo}
                      />
                    </div>
                  );
                })
              ) : (
                <div className="flex-1 flex items-center justify-center text-text-secondary">
                  <div className="text-center p-8">
                    <div className="text-4xl mb-4">⚡</div>
                    <h2 className="text-xl font-semibold mb-2">No Active Panel</h2>
                    <p className="text-sm">Add a tool panel to get started</p>
                  </div>
                </div>
              )}
            </div>

            {/* Right: detail panel */}
            <DetailPanel
              isVisible={detailVisible}
              onToggle={() => setDetailVisible(v => !v)}
              width={detailWidth}
              onResize={startDetailResize}
              projectGitActions={{
                onPull: handleGitPull,
                onPush: handleGitPush,
                isMerging
              }}
            />
          </div>
        </SessionProvider>
      )}

      {/* Loading state when no session yet */}
      {!mainRepoSessionId && (
        <div className="flex-1 animate-pulse">
          {/* Tab bar skeleton */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border-primary bg-surface-secondary">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-7 w-20 bg-surface-tertiary rounded" />
            ))}
          </div>
          {/* Panel content skeleton */}
          <div className="p-4 space-y-3">
            <div className="h-4 w-48 bg-surface-tertiary rounded" />
            <div className="h-3 w-full bg-surface-tertiary rounded" />
            <div className="h-3 w-3/4 bg-surface-tertiary rounded" />
            <div className="h-3 w-5/6 bg-surface-tertiary rounded" />
            <div className="h-3 w-1/2 bg-surface-tertiary rounded" />
          </div>
        </div>
      )}
    </div>
  );
};
