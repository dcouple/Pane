import { useRef, useEffect, useState, memo, useMemo, useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionHistoryStore } from '../stores/sessionHistoryStore';
import { useHotkey } from '../hooks/useHotkey';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { HomePage } from './HomePage';
import '@xterm/xterm/css/xterm.css';
import { useSessionView } from '../hooks/useSessionView';
import { DetailPanel } from './DetailPanel';
import { GitErrorDialog } from './session/GitErrorDialog';
import { CommitMessageDialog } from './session/CommitMessageDialog';
import { FolderArchiveDialog } from './session/FolderArchiveDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { ProjectView } from './ProjectView';
import { API } from '../utils/api';
import { useResizable } from '../hooks/useResizable';
import { useResizableHeight } from '../hooks/useResizableHeight';
import { usePanelStore } from '../stores/panelStore';
import { panelApi } from '../services/panelApi';
import { setPendingViewCommit } from './panels/diff/CombinedDiffView';
import { PanelTabBar } from './panels/PanelTabBar';
import { PanelContainer } from './panels/PanelContainer';
import { SessionProvider } from '../contexts/SessionContext';
import { ToolPanel, ToolPanelType, PANEL_CAPABILITIES } from '../../../shared/types/panels';
import { PanelCreateOptions } from '../types/panelComponents';
import { Download, Upload, GitMerge, GitPullRequestArrow, Terminal, ChevronDown, ChevronUp, RefreshCw, Archive, ArchiveRestore, GitCommitHorizontal, TerminalSquare, Undo2 } from 'lucide-react';
import { ClaudeIcon, OpenAIIcon, getCliBrandIcon } from './ui/BrandIcons';
import type { Project } from '../types/project';
import { devLog, renderLog } from '../utils/console';
import { useConfigStore } from '../stores/configStore';
import { cycleIndex } from '../utils/arrayUtils';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { Tooltip } from './ui/Tooltip';
import { Kbd } from './ui/Kbd';
import { useErrorStore } from '../stores/errorStore';
import ProjectSettings from './ProjectSettings';

export const SessionView = memo(() => {
  const { activeView, activeProjectId } = useNavigationStore();
  const [projectData, setProjectData] = useState<Project | null>(null);
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [isMergingProject, setIsMergingProject] = useState(false);
  const [sessionProject, setSessionProject] = useState<Project | null>(null);
  const [showSetTrackingDialog, setShowSetTrackingDialog] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [currentUpstream, setCurrentUpstream] = useState<string | null>(null);

  // Config store for custom commands in terminal row pills
  const { config, fetchConfig } = useConfigStore();
  useEffect(() => { if (!config) { fetchConfig(); } }, [config, fetchConfig]);
  const customCommands = useMemo(
    () => (config?.customCommands ?? []).filter(cmd => cmd?.name && cmd?.command),
    [config?.customCommands]
  );

  // Get active session by subscribing directly to store state
  // This ensures the component re-renders when git status or other session properties update
  const activeSession = useSessionStore((state) => {
    if (!state.activeSessionId) return undefined;
    // Check main repo session first
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === state.activeSessionId) {
      return state.activeMainRepoSession;
    }
    // Otherwise look in regular sessions
    return state.sessions.find(session => session.id === state.activeSessionId);
  });

  // Panel store state and actions
  const {
    panels,
    activePanels,
    setPanels,
    setActivePanel: setActivePanelInStore,
    addPanel,
    removePanel,
    updatePanelState,
  } = usePanelStore();
  
  // History store for navigation
  const { addToHistory } = useSessionHistoryStore();

  // Load panels when session changes
  useEffect(() => {
    if (activeSession?.id) {
      devLog.debug('[SessionView] Loading panels for session:', activeSession.id);

      // Always reload panels from database when switching sessions
      // to ensure we get the latest saved state
      panelApi.loadPanelsForSession(activeSession.id).then(loadedPanels => {
        devLog.debug('[SessionView] Loaded panels:', loadedPanels);
        setPanels(activeSession.id, loadedPanels);

        // Pick default active: prefer diff, then explorer, then first panel
        const fallback = loadedPanels.find(p => p.type === 'diff')
          || loadedPanels.find(p => p.type === 'explorer')
          || loadedPanels[0];

        return panelApi.getActivePanel(activeSession.id).then(activePanel => {
          console.log('[SessionView] Active panel from backend:', activePanel);
          if (activePanel) {
            setActivePanelInStore(activeSession.id, activePanel.id);
          } else if (fallback) {
            setActivePanelInStore(activeSession.id, fallback.id);
            panelApi.setActivePanel(activeSession.id, fallback.id);
          }
        });
      });
    }
  }, [activeSession?.id, setPanels, setActivePanelInStore]); // Remove panels from deps to avoid skipping reload
  
  // Listen for panel updates from the backend
  useEffect(() => {
    if (!activeSession?.id) return;
    
    // Handle panel creation events (for logs panel auto-creation)
    const handlePanelCreated = (panel: ToolPanel) => {
      console.log('[SessionView] Received panel:created event:', panel);
      
      // Only add if it's for the current session
      if (panel.sessionId === activeSession.id) {
        // Check if panel already exists to prevent duplicates
        const existingPanels = panels[activeSession.id] || [];
        const panelExists = existingPanels.some(p => p.id === panel.id);
        
        if (!panelExists) {
          console.log('[SessionView] Adding new panel to store:', panel);
          addPanel(panel);
        } else {
          console.log('[SessionView] Panel already exists, not adding duplicate:', panel.id);
        }
      }
    };
    
    const handlePanelUpdated = (updatedPanel: ToolPanel) => {
      console.log('[SessionView] Received panel:updated event:', updatedPanel);
      
      // Only update if it's for the current session
      if (updatedPanel.sessionId === activeSession.id) {
        console.log('[SessionView] Updating panel in store:', updatedPanel);
        updatePanelState(updatedPanel);
      }
    };
    
    // Listen for panel events
    const unsubscribeCreated = window.electronAPI?.events?.onPanelCreated?.(handlePanelCreated);
    const unsubscribeUpdated = window.electronAPI?.events?.onPanelUpdated?.(handlePanelUpdated);
    
    // Cleanup
    return () => {
      unsubscribeCreated?.();
      unsubscribeUpdated?.();
    };
  }, [activeSession?.id, addPanel, updatePanelState, panels]);

  // Get panels for current session with memoization
  const sessionPanels = useMemo(
    () => panels[activeSession?.id || ''] || [],
    [panels, activeSession?.id]
  );

  // Bottom terminal panel (first terminal panel in session)
  const defaultTerminalPanel = useMemo(
    () => sessionPanels.find(p => p.type === 'terminal'),
    [sessionPanels]
  );

  // Non-terminal panels for the tab bar (exclude the default terminal that's pinned to the bottom)
  const tabBarPanels = useMemo(
    () => defaultTerminalPanel
      ? sessionPanels.filter(p => p.id !== defaultTerminalPanel.id)
      : sessionPanels,
    [sessionPanels, defaultTerminalPanel]
  );

  // Sort tab bar panels same as PanelTabBar: diff first, explorer second, then by position
  const sortedSessionPanels = useMemo(() => {
    const typeOrder = (type: string) => {
      if (type === 'diff') return 0;
      if (type === 'explorer') return 1;
      return 2;
    };
    return [...tabBarPanels].sort((a, b) => {
      const orderDiff = typeOrder(a.type) - typeOrder(b.type);
      if (orderDiff !== 0) return orderDiff;
      return (a.metadata?.position ?? 0) - (b.metadata?.position ?? 0);
    });
  }, [tabBarPanels]);

  const currentActivePanel = useMemo(
    () => sessionPanels.find(p => p.id === activePanels[activeSession?.id || '']),
    [sessionPanels, activePanels, activeSession?.id]
  );

  // Track current session/panel in history when they change
  useEffect(() => {
    if (activeSession?.id && currentActivePanel?.id) {
      addToHistory(activeSession.id, currentActivePanel.id);
    }
  }, [activeSession?.id, currentActivePanel?.id, addToHistory]);

  // Debug logging - only in development with verbose enabled
  renderLog('[SessionView] Session panels:', sessionPanels);
  renderLog('[SessionView] Active panel ID:', activePanels[activeSession?.id || '']);
  renderLog('[SessionView] Current active panel:', currentActivePanel);

  // FIX: Memoize all callbacks to prevent re-renders
  const handlePanelSelect = useCallback(
    async (panel: ToolPanel) => {
      if (!activeSession) return;

      // Add to history when panel is selected
      addToHistory(activeSession.id, panel.id);

      setActivePanelInStore(activeSession.id, panel.id);
      await panelApi.setActivePanel(activeSession.id, panel.id);
    },
    [activeSession, setActivePanelInStore, addToHistory]
  );

  const handleCommitClick = useCallback(
    (commitHash: string) => {
      if (!activeSession || sessionPanels.length === 0) return;
      const diffPanel = sessionPanels.find(p => p.type === 'diff');
      if (!diffPanel) return;
      handlePanelSelect(diffPanel);
      // Store pending hash before dispatching — if the diff panel is not
      // currently active, CombinedDiffView is unmounted and will read this
      // module-level variable when it mounts after the panel switch.
      setPendingViewCommit(activeSession.id, commitHash);
      window.dispatchEvent(new CustomEvent('diff:view-commit', {
        detail: { sessionId: activeSession.id, commitHash },
      }));
    },
    [activeSession, sessionPanels, handlePanelSelect]
  );

  // Tab cycling: navigates between panels in the current session using
  // keyboard shortcuts. Supports wrap-around (last → first). Only enabled
  // when there are 2+ panels. Uses sortedSessionPanels to match tab bar order.
  const cycleTab = useCallback((direction: 'next' | 'prev') => {
    if (!activeSession || sortedSessionPanels.length < 2) return;

    const currentIndex = sortedSessionPanels.findIndex(
      p => p.id === currentActivePanel?.id
    );
    const nextIndex = cycleIndex(currentIndex, sortedSessionPanels.length, direction);
    if (nextIndex === -1) return;

    const nextPanel = sortedSessionPanels[nextIndex];
    handlePanelSelect(nextPanel);
  }, [activeSession, sortedSessionPanels, currentActivePanel, handlePanelSelect]);

  // Tab cycling hotkeys
  useHotkey({
    id: 'cycle-tab-prev-a',
    label: 'Previous Tab',
    keys: 'mod+a',
    category: 'tabs',
    enabled: () => sortedSessionPanels.length > 1,
    action: () => cycleTab('prev'),
    showInPalette: true,
  });

  useHotkey({
    id: 'cycle-tab-next-d',
    label: 'Next Tab',
    keys: 'mod+d',
    category: 'tabs',
    enabled: () => sortedSessionPanels.length > 1,
    action: () => cycleTab('next'),
    showInPalette: true,
  });

  // Mod+Shift+1 through Mod+Shift+9 to switch between panel tabs
  const panelLabel = (i: number) => {
    const p = sortedSessionPanels[i];
    if (!p) return `Switch to tab ${i + 1}`;
    const name = p.type === 'diff' ? 'Diff' : p.title;
    return `Switch to ${name}`;
  };
  useHotkey({ id: 'panel-tab-1', label: panelLabel(0), keys: 'mod+shift+1', category: 'tabs', enabled: () => !!sortedSessionPanels[0], action: () => { const p = sortedSessionPanels[0]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-2', label: panelLabel(1), keys: 'mod+shift+2', category: 'tabs', enabled: () => !!sortedSessionPanels[1], action: () => { const p = sortedSessionPanels[1]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-3', label: panelLabel(2), keys: 'mod+shift+3', category: 'tabs', enabled: () => !!sortedSessionPanels[2], action: () => { const p = sortedSessionPanels[2]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-4', label: panelLabel(3), keys: 'mod+shift+4', category: 'tabs', enabled: () => !!sortedSessionPanels[3], action: () => { const p = sortedSessionPanels[3]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-5', label: panelLabel(4), keys: 'mod+shift+5', category: 'tabs', enabled: () => !!sortedSessionPanels[4], action: () => { const p = sortedSessionPanels[4]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-6', label: panelLabel(5), keys: 'mod+shift+6', category: 'tabs', enabled: () => !!sortedSessionPanels[5], action: () => { const p = sortedSessionPanels[5]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-7', label: panelLabel(6), keys: 'mod+shift+7', category: 'tabs', enabled: () => !!sortedSessionPanels[6], action: () => { const p = sortedSessionPanels[6]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-8', label: panelLabel(7), keys: 'mod+shift+8', category: 'tabs', enabled: () => !!sortedSessionPanels[7], action: () => { const p = sortedSessionPanels[7]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-9', label: panelLabel(8), keys: 'mod+shift+9', category: 'tabs', enabled: () => !!sortedSessionPanels[8], action: () => { const p = sortedSessionPanels[8]; if (p) handlePanelSelect(p); } });

  // --- Add Tool commands (palette-only, no keybindings) ---
  // Only enabled in session view (not project view) to prevent hidden panel mutations
  const isInSessionView = !!activeSession && activeView !== 'project';

  useHotkey({
    id: 'add-tool-terminal',
    label: 'Add Terminal',
    keys: 'mod+alt+1',
    category: 'tools',
    enabled: () => isInSessionView,
    action: () => handlePanelCreate('terminal'),
  });

  useHotkey({
    id: 'add-tool-explorer',
    label: 'Add Explorer',
    keys: 'mod+alt+2',
    category: 'tools',
    enabled: () => isInSessionView && !sessionPanels.some(p => p.type === 'explorer'),
    action: () => handlePanelCreate('explorer'),
  });

  useHotkey({
    id: 'add-tool-terminal-claude',
    label: 'Add Claude Code',
    keys: 'mod+alt+3',
    category: 'tools',
    enabled: () => isInSessionView,
    action: () => handlePanelCreate('terminal', {
      initialCommand: 'claude --dangerously-skip-permissions',
      title: 'Claude Code'
    }),
  });

  useHotkey({
    id: 'add-tool-terminal-codex',
    label: 'Add Codex',
    keys: 'mod+alt+4',
    category: 'tools',
    enabled: () => isInSessionView,
    action: () => handlePanelCreate('terminal', {
      initialCommand: 'codex',
      title: 'Codex'
    }),
  });

  // Close active panel tab (skip permanent panels like diff)
  const closeTabEnabled = () => {
    if (!currentActivePanel) return false;
    const caps = PANEL_CAPABILITIES[currentActivePanel.type];
    return !caps?.permanent && !currentActivePanel.metadata?.permanent;
  };
  const closeTabAction = () => {
    if (currentActivePanel) handlePanelClose(currentActivePanel);
  };

  useHotkey({
    id: 'close-active-tab',
    label: 'Close active tab',
    keys: 'mod+w',
    category: 'tabs',
    enabled: closeTabEnabled,
    action: closeTabAction,
  });

  useHotkey({
    id: 'archive-active-session',
    label: 'Archive Pane',
    keys: 'mod+shift+w',
    category: 'session',
    enabled: () => !!activeSession && !activeSession.archived,
    action: () => hook.setShowArchiveConfirm(true),
  });

  const handlePanelClose = useCallback(
    async (panel: ToolPanel) => {
      if (!activeSession) return;
      
      // Find next panel to activate
      const panelIndex = sessionPanels.findIndex(p => p.id === panel.id);
      const nextPanel = sessionPanels[panelIndex + 1] || sessionPanels[panelIndex - 1];
      
      // Remove from store first for immediate UI update
      removePanel(activeSession.id, panel.id);
      
      // Set next active panel if available
      if (nextPanel) {
        setActivePanelInStore(activeSession.id, nextPanel.id);
        await panelApi.setActivePanel(activeSession.id, nextPanel.id);
      }
      
      // Delete on backend
      await panelApi.deletePanel(panel.id);
    },
    [activeSession, sessionPanels, removePanel, setActivePanelInStore]
  );

  const handlePanelCreate = useCallback(
    async (type: ToolPanelType, options?: PanelCreateOptions) => {
      if (!activeSession) return;

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
        sessionId: activeSession.id,
        type,
        title: options?.title,
        initialState
      });

      // Immediately add the panel and set it as active
      // The panel:created event will also fire, but addPanel checks for duplicates
      addPanel(newPanel);
      setActivePanelInStore(activeSession.id, newPanel.id);
    },
    [activeSession, addPanel, setActivePanelInStore]
  );

  // Dynamic shortcuts for custom commands (mod+shift+5, 6, 7, ...)
  const registerHotkey = useHotkeyStore((s) => s.register);
  const unregisterHotkey = useHotkeyStore((s) => s.unregister);
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = useCallback((id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  }, [hotkeys]);
  const handlePanelCreateRef = useRef(handlePanelCreate);
  handlePanelCreateRef.current = handlePanelCreate;
  const isInSessionViewRef = useRef(isInSessionView);
  isInSessionViewRef.current = isInSessionView;

  useEffect(() => {
    const CUSTOM_CMD_START = 5; // mod+alt+1-4 are taken by built-in tools
    const maxSlots = Math.min(customCommands.length, 5); // mod+alt+5 through 9
    const ids: string[] = [];

    for (let i = 0; i < maxSlots; i++) {
      const cmd = customCommands[i];
      const id = `add-tool-custom-${i}`;
      ids.push(id);
      registerHotkey({
        id,
        label: `Add ${cmd.name}`,
        keys: `mod+alt+${CUSTOM_CMD_START + i}`,
        category: 'tools',
        enabled: () => isInSessionViewRef.current,
        action: () => handlePanelCreateRef.current('terminal', {
          initialCommand: cmd.command,
          title: cmd.name,
        }),
      });
    }

    return () => { ids.forEach(id => unregisterHotkey(id)); };
  }, [customCommands, registerHotkey, unregisterHotkey]);

  // Load project data for active session
  useEffect(() => {
    const loadSessionProject = async () => {
      if (activeSession?.projectId) {
        try {
          const response = await API.projects.getAll();
          if (response.success && response.data) {
            const project = response.data.find((p: Project) => p.id === activeSession.projectId);
            if (project) {
              setSessionProject(project);
            }
          }
        } catch (error) {
          console.error('Failed to load session project:', error);
        }
      } else {
        setSessionProject(null);
      }
    };
    loadSessionProject();
  }, [activeSession?.projectId]);

  // Fetch upstream tracking branch for display
  useEffect(() => {
    if (!activeSession?.id || activeSession.isMainRepo) {
      setCurrentUpstream(null);
      return;
    }
    let cancelled = false;
    API.sessions.getUpstream(activeSession.id).then(response => {
      if (cancelled) return;
      setCurrentUpstream(response.success ? response.data : null);
    }).catch(() => {
      if (!cancelled) setCurrentUpstream(null);
    });
    return () => { cancelled = true; };
  }, [activeSession?.id, activeSession?.isMainRepo]);

  // Load project data when activeProjectId changes
  useEffect(() => {
    if (activeView === 'project' && activeProjectId) {
      const loadProjectData = async () => {
        setIsProjectLoading(true);
        try {
          // Get all projects and find the one we need
          const response = await API.projects.getAll();
          if (response.success && response.data) {
            const project = response.data.find((p: Project) => p.id === activeProjectId);
            if (project) {
              setProjectData(project);
            }
          }
        } catch (error) {
          console.error('Failed to load project data:', error);
        } finally {
          setIsProjectLoading(false);
        }
      };
      loadProjectData();
    } else {
      setProjectData(null);
    }
  }, [activeView, activeProjectId]);

  const handleProjectGitPull = async () => {
    if (!activeProjectId || !projectData) return;
    setIsMergingProject(true);
    try {
      // Get or create main repo session for this project
      const sessionResponse = await API.sessions.getOrCreateMainRepoSession(activeProjectId);
      if (sessionResponse.success && sessionResponse.data) {
        const response = await API.sessions.gitPull(sessionResponse.data.id);
        if (!response.success) {
          console.error('Git pull failed:', response.error);
        }
      }
    } catch (error) {
      console.error('Failed to perform git pull:', error);
    } finally {
      setIsMergingProject(false);
    }
  };

  const handleProjectGitPush = async () => {
    if (!activeProjectId || !projectData) return;
    setIsMergingProject(true);
    try {
      // Get or create main repo session for this project
      const sessionResponse = await API.sessions.getOrCreateMainRepoSession(activeProjectId);
      if (sessionResponse.success && sessionResponse.data) {
        const response = await API.sessions.gitPush(sessionResponse.data.id);
        if (!response.success) {
          console.error('Git push failed:', response.error);
        }
      }
    } catch (error) {
      console.error('Failed to perform git push:', error);
    } finally {
      setIsMergingProject(false);
    }
  };

  const hook = useSessionView(activeSession);

  // Handler to open set tracking dialog
  const handleOpenSetTracking = async () => {
    if (!activeSession) return;
    const sessionIdAtStart = activeSession.id;
    try {
      const [branchesResponse, upstreamResponse] = await Promise.all([
        API.sessions.getRemoteBranches(activeSession.id),
        API.sessions.getUpstream(activeSession.id)
      ]);
      // Guard against stale responses if session changed during async call
      if (activeSession.id !== sessionIdAtStart) return;
      if (branchesResponse.success && branchesResponse.data) {
        setRemoteBranches(branchesResponse.data);
      }
      if (upstreamResponse.success) {
        setCurrentUpstream(upstreamResponse.data);
      }
      setShowSetTrackingDialog(true);
    } catch (error) {
      console.error('Failed to fetch remote branches:', error);
    }
  };

  const handleSelectUpstream = async (branch: string) => {
    if (!activeSession) return;
    setShowSetTrackingDialog(false);
    const success = await hook.handleSetUpstream(branch);
    if (success) {
      setCurrentUpstream(branch);
    }
  };

  // IDE dropdown handlers
  const [showProjectSettings, setShowProjectSettings] = useState(false);

  const handleOpenIDEWithCommand = useCallback(async (ideKey?: string) => {
    if (!activeSession) return;
    try {
      const response = await API.sessions.openIDE(activeSession.id, ideKey);
      if (!response.success) {
        useErrorStore.getState().showError({
          title: 'Failed to open IDE',
          error: response.error || 'Unknown error occurred',
        });
      }
    } catch (error) {
      useErrorStore.getState().showError({
        title: 'Failed to open IDE',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  }, [activeSession]);

  // Detail panel state
  const [detailVisible, setDetailVisible] = useState(() => {
    const stored = localStorage.getItem('pane-detail-panel-visible');
    return stored !== null ? stored === 'true' : true;
  });

  // Persist detail panel visibility
  useEffect(() => {
    localStorage.setItem('pane-detail-panel-visible', String(detailVisible));
  }, [detailVisible]);

  // Right-side resizable
  const { width: detailWidth, startResize: startDetailResize } = useResizable({
    defaultWidth: 200,
    minWidth: 140,
    maxWidth: 350,
    storageKey: 'pane-detail-panel-width',
    side: 'right'
  });

  // Layout swap state
  const [layoutSwapped, setLayoutSwapped] = useState(() => {
    return localStorage.getItem('pane-layout-swapped') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('pane-layout-swapped', String(layoutSwapped));
  }, [layoutSwapped]);

  const toggleLayoutSwap = useCallback(() => {
    setLayoutSwapped(prev => !prev);
  }, []);

  // Auto-collapse sidebars for immersive panels (diff, explorer)
  const isImmersivePanel = currentActivePanel ? currentActivePanel.type === 'diff' || currentActivePanel.type === 'explorer' : false;
  const setImmersiveMode = useNavigationStore(s => s.setImmersiveMode);
  const immersiveMode = useNavigationStore(s => s.immersiveMode);

  useEffect(() => {
    setImmersiveMode(isImmersivePanel);
    return () => {
      setImmersiveMode(false);
    };
  }, [isImmersivePanel, setImmersiveMode]);

  // Auto-create terminal panel for existing sessions that don't have one
  // Unless the user has explicitly closed it previously
  const hasTriedCreatingTerminal = useRef(false);
  useEffect(() => {
    if (!activeSession?.id || defaultTerminalPanel || hasTriedCreatingTerminal.current) return;
    // Only attempt once per session to avoid loops
    hasTriedCreatingTerminal.current = true;

    // Check if user has previously closed terminal panel for this session
    window.electronAPI?.invoke('panels:shouldAutoCreate', activeSession.id, 'terminal').then(shouldCreate => {
      if (!shouldCreate) {
        console.log('[SessionView] Skipping terminal auto-create - user previously closed it');
        return;
      }
      panelApi.createPanel({
        sessionId: activeSession.id,
        type: 'terminal',
        title: 'Terminal',
      }).then(panel => {
        addPanel(panel);
      }).catch(err => {
        console.error('[SessionView] Failed to auto-create terminal panel:', err);
      });
    });
  }, [activeSession?.id, defaultTerminalPanel, addPanel]);

  // Reset the flag when session changes
  useEffect(() => {
    hasTriedCreatingTerminal.current = false;
  }, [activeSession?.id]);

  const { height: terminalHeight, startResize: startTerminalResize } = useResizableHeight({
    defaultHeight: 200,
    minHeight: 100,
    maxHeight: 500,
    storageKey: 'pane-bottom-terminal-height',
  });

  // Resizable width for terminal when it occupies the right column (swapped layout)
  const { width: rightTerminalWidth, startResize: startRightTerminalResize } = useResizable({
    defaultWidth: 350,
    minWidth: 200,
    maxWidth: 600,
    storageKey: 'pane-right-terminal-width',
    side: 'right',
  });

  // Resizable height for detail panel when it is the bottom bar (swapped layout)
  const { height: detailBottomHeight, startResize: startDetailBottomResize } = useResizableHeight({
    defaultHeight: 200,
    minHeight: 80,
    maxHeight: 400,
    storageKey: 'pane-bottom-detail-height',
  });

  const [isDetailCollapsed, setIsDetailCollapsed] = useState(() => {
    const stored = localStorage.getItem('pane-detail-collapsed');
    return stored === null ? false : stored === 'true';
  });

  const toggleDetailCollapse = useCallback(() => {
    setIsDetailCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('pane-detail-collapsed', String(newValue));
      return newValue;
    });
  }, []);

  // Terminal collapse state with localStorage persistence (collapsed by default)
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(() => {
    const stored = localStorage.getItem('pane-terminal-collapsed');
    return stored === null ? true : stored === 'true';
  });

  const toggleTerminalCollapse = useCallback(() => {
    setIsTerminalCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('pane-terminal-collapsed', String(newValue));
      return newValue;
    });
  }, []);

  // Ctrl+`: toggle bottom terminal
  useHotkey({
    id: 'toggle-terminal',
    label: 'Toggle Terminal',
    keys: 'mod+`',
    category: 'view',
    enabled: () => isInSessionView,
    action: toggleTerminalCollapse,
  });

  // Ctrl+Shift+B: toggle detail panel (right sidebar)
  useHotkey({
    id: 'toggle-detail-panel',
    label: 'Toggle Detail Panel',
    keys: 'mod+shift+b',
    category: 'view',
    enabled: () => isInSessionView,
    action: () => {
      if (layoutSwapped) {
        toggleDetailCollapse();
      } else {
        setDetailVisible(v => !v);
      }
    },
  });

  // Create branch actions for the panel bar
  const branchActions = useMemo(() => {
    if (!activeSession) return [];
    
    return activeSession.isMainRepo ? [
      {
        id: 'pull',
        label: 'Pull from Remote',
        icon: Download,
        onClick: hook.handleGitPull,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'default' as const,
        description: hook.gitCommands?.getPullCommand ? `git ${hook.gitCommands.getPullCommand()}` : 'git pull'
      },
      {
        id: 'push',
        label: 'Push to Remote', 
        icon: Upload,
        onClick: hook.handleGitPush,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'success' as const,
        description: hook.gitCommands?.getPushCommand ? `git ${hook.gitCommands.getPushCommand()}` : 'git push'
      }
    ] : [
      // --- Sync ---
      {
        id: 'fetch',
        label: 'Fetch',
        icon: RefreshCw,
        onClick: hook.handleGitFetch,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'default' as const,
        description: `Fetch from remote into ${hook.gitCommands?.currentBranch || 'current branch'} without merging`
      },
      // --- Update working tree ---
      {
        id: 'stash',
        label: 'Stash',
        icon: Archive,
        onClick: hook.handleGitStash,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !activeSession.gitStatus?.hasUncommittedChanges,
        variant: 'default' as const,
        description: activeSession.gitStatus?.hasUncommittedChanges
          ? `Stash uncommitted changes on ${hook.gitCommands?.currentBranch || 'current branch'}`
          : 'No changes to stash'
      },
      {
        id: 'stash-pop',
        label: 'Pop',
        icon: ArchiveRestore,
        onClick: hook.handleGitStashPop,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !hook.hasStash,
        variant: 'default' as const,
        description: hook.hasStash ? 'Apply and remove most recent stash' : 'No stash to pop'
      },
      // --- Commit & push ---
      {
        id: 'commit',
        label: 'Commit',
        icon: GitCommitHorizontal,
        shortcut: 'mod+shift+k',
        onClick: () => {
          hook.setDialogType('commit');
          hook.setShowCommitMessageDialog(true);
        },
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || (!activeSession.gitStatus?.hasUncommittedChanges && !activeSession.gitStatus?.hasUntrackedFiles),
        variant: 'default' as const,
        description: (activeSession.gitStatus?.hasUncommittedChanges || activeSession.gitStatus?.hasUntrackedFiles)
          ? `Stage all changes and commit on ${hook.gitCommands?.currentBranch || 'current branch'}`
          : 'No changes to commit'
      },
      {
        id: 'pull',
        label: 'Pull',
        icon: Download,
        shortcut: 'mod+shift+l',
        onClick: hook.handleGitPull,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'default' as const,
        description: `Pull latest changes into ${hook.gitCommands?.currentBranch || 'current branch'}`
      },
      {
        id: 'push',
        label: 'Push',
        icon: Upload,
        shortcut: 'mod+shift+p',
        onClick: hook.handleGitPush,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !activeSession.gitStatus?.ahead,
        variant: 'default' as const,
        description: activeSession.gitStatus?.ahead
          ? `Push ${activeSession.gitStatus.ahead} commit(s)${hook.gitCommands?.currentBranch ? ` from ${hook.gitCommands.currentBranch}` : ''} to remote`
          : 'No commits to push'
      },
      {
        id: 'undo-commit',
        label: 'Undo Commit',
        icon: Undo2,
        shortcut: 'mod+shift+z',
        onClick: hook.handleGitSoftReset,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !activeSession.gitStatus?.ahead,
        variant: 'default' as const,
        description: activeSession.gitStatus?.ahead
          ? 'Undo last commit, keeping changes staged (git reset --soft HEAD~1)'
          : 'No commits to undo'
      },
      // --- Main branch operations (last) ---
      {
        id: 'rebase-from-main',
        label: `Rebase from ${hook.gitCommands?.mainBranch || 'main'}`,
        icon: GitPullRequestArrow,
        shortcut: 'mod+shift+r',
        onClick: hook.handleRebaseMainIntoWorktree,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !hook.hasChangesToRebase,
        variant: 'default' as const,
        description: hook.gitCommands?.getRebaseFromMainCommand ? hook.gitCommands.getRebaseFromMainCommand() : `Pulls latest changes from ${hook.gitCommands?.mainBranch || 'main'}`
      },
      {
        id: 'rebase-to-main',
        label: `Merge to ${hook.gitCommands?.mainBranch || 'main'}`,
        icon: GitMerge,
        shortcut: 'mod+shift+m',
        onClick: hook.handleSquashAndRebaseToMain,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' ||
                  (!activeSession.gitStatus?.totalCommits || activeSession.gitStatus?.totalCommits === 0 || activeSession.gitStatus?.ahead === 0),
        variant: 'success' as const,
        description: (!activeSession.gitStatus?.totalCommits || activeSession.gitStatus?.totalCommits === 0 || activeSession.gitStatus?.ahead === 0) ?
                     'No commits to merge' :
                     (hook.gitCommands?.getSquashAndRebaseToMainCommand ? hook.gitCommands.getSquashAndRebaseToMainCommand() : `Merges all commits to ${hook.gitCommands?.mainBranch || 'main'} (with safety checks)`)
      }
    ];
  }, [activeSession, hook.isMerging, hook.gitCommands, hook.hasChangesToRebase, hook.hasStash, hook.handleGitPull, hook.handleGitPush, hook.handleGitSoftReset, hook.handleGitFetch, hook.handleGitStash, hook.handleGitStashPop, hook.setShowCommitMessageDialog, hook.setDialogType, hook.handleRebaseMainIntoWorktree, hook.handleSquashAndRebaseToMain, activeSession?.gitStatus]);
  
  // Removed unused variables - now handled by panels

  // Show project view if navigation is set to project
  if (activeView === 'project' && activeProjectId) {
    if (isProjectLoading || !projectData) {
      return (
        <div className="flex-1 flex flex-col overflow-hidden bg-surface-secondary p-6">
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-interactive mx-auto mb-4"></div>
              <p className="text-text-secondary">Loading project...</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <ProjectView
        projectId={activeProjectId}
        projectName={projectData.name || 'Project'}
        onGitPull={handleProjectGitPull}
        onGitPush={handleProjectGitPush}
        isMerging={isMergingProject}
      />
    );
  }

  if (!activeSession) {
    return <HomePage />;
  }
  
  return (
    <div className="pane-session-shell flex-1 flex flex-col overflow-hidden bg-bg-primary">
      {/* SINGLE SessionProvider wraps everything */}
      <SessionProvider session={activeSession} gitBranchActions={branchActions} isMerging={hook.isMerging} gitCommands={hook.gitCommands} onOpenIDEWithCommand={handleOpenIDEWithCommand} onConfigureIDE={() => setShowProjectSettings(true)} onSetTracking={handleOpenSetTracking} trackingBranch={currentUpstream} configuredIDECommand={sessionProject?.open_ide_command}>

        {/* Tab bar at top */}
        <PanelTabBar
          panels={tabBarPanels}
          activePanel={currentActivePanel}
          onPanelSelect={handlePanelSelect}
          onPanelClose={handlePanelClose}
          onPanelCreate={handlePanelCreate}
          onToggleDetailPanel={() => {
            if (layoutSwapped) {
              toggleDetailCollapse();
            } else {
              setDetailVisible(v => !v);
            }
          }}
          detailPanelVisible={detailVisible}
        />

        {/* Content area: center panels + right detail */}
        <div className="pane-session-content flex-1 flex flex-row min-h-0">
          {layoutSwapped && defaultTerminalPanel ? (
            <>
              {/* SWAPPED LAYOUT: Center column with panels on top, horizontal detail panel on bottom */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Top: active panel content */}
                <div className="pane-editor-stage flex-1 relative min-h-0 overflow-hidden bg-bg-editor">
                  {sessionPanels.length > 0 && currentActivePanel ? (
                    sessionPanels
                      .filter(p => !defaultTerminalPanel || p.id !== defaultTerminalPanel.id)
                      .map(panel => {
                        const isActive = panel.id === currentActivePanel.id;
                        const shouldKeepAlive = ['terminal'].includes(panel.type);
                        if (!isActive && !shouldKeepAlive) return null;
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
                              isMainRepo={!!activeSession.isMainRepo}
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

                {/* Bottom: horizontal detail panel */}
                <DetailPanel
                  isVisible={true}
                  onToggle={toggleDetailCollapse}
                  width={0}
                  height={detailBottomHeight}
                  onResize={startDetailBottomResize}
                  mergeError={hook.mergeError}
                  orientation="horizontal"
                  isCollapsed={isDetailCollapsed}
                  onToggleCollapse={toggleDetailCollapse}
                  onSwapLayout={toggleLayoutSwap}
                  onCommitClick={handleCommitClick}
                  terminalShortcuts={
                    <>
                      <Tooltip content={hotkeyDisplay('add-tool-terminal-claude') ? <Kbd>{hotkeyDisplay('add-tool-terminal-claude')}</Kbd> : undefined} side="top">
                        <button
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-text-tertiary border border-border-primary hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap flex-shrink-0"
                          onClick={() => handlePanelCreate('terminal', {
                            initialCommand: 'claude --dangerously-skip-permissions',
                            title: 'Claude Code'
                          })}
                        >
                          <ClaudeIcon className="w-3 h-3" />
                          Claude
                        </button>
                      </Tooltip>
                      <Tooltip content={hotkeyDisplay('add-tool-terminal-codex') ? <Kbd>{hotkeyDisplay('add-tool-terminal-codex')}</Kbd> : undefined} side="top">
                        <button
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-text-tertiary border border-border-primary hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap flex-shrink-0"
                          onClick={() => handlePanelCreate('terminal', {
                            initialCommand: 'codex',
                            title: 'Codex'
                          })}
                        >
                          <OpenAIIcon className="w-3 h-3" />
                          Codex
                        </button>
                      </Tooltip>
                      {customCommands.map((cmd, index) => {
                        const shortcutDisplay = hotkeyDisplay(`add-tool-custom-${index}`);
                        const pill = (
                          <button
                            key={`shortcut-${index}`}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-text-tertiary border border-border-primary hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap flex-shrink-0"
                            onClick={() => handlePanelCreate('terminal', {
                              initialCommand: cmd.command,
                              title: cmd.name
                            })}
                            title={cmd.command}
                          >
                            {getCliBrandIcon(cmd.command, 'w-3 h-3') || <TerminalSquare className="w-3 h-3" />}
                            {cmd.name.length > 18 ? cmd.name.slice(0, 18) + '...' : cmd.name}
                          </button>
                        );
                        return shortcutDisplay ? (
                          <Tooltip key={`shortcut-${index}`} content={<Kbd>{shortcutDisplay}</Kbd>} side="top">
                            {pill}
                          </Tooltip>
                        ) : pill;
                      })}
                    </>
                  }
                />
              </div>

              {/* Right column: terminal at full height — outer wrapper clips, inner stays fixed width so xterm doesn't reflow */}
              <div
                className={`pane-terminal-rail flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${immersiveMode ? '' : 'border-l border-border-primary'}`}
                style={{ width: immersiveMode ? '0px' : `${rightTerminalWidth}px` }}
              >
                <div
                  className="pane-terminal-rail-shell bg-surface-primary flex flex-col h-full relative"
                  style={{ width: `${rightTerminalWidth}px` }}
                >
                  {/* Resize handle on left edge */}
                  <div
                    className="absolute top-0 left-0 w-1 h-full cursor-col-resize group z-10"
                    onMouseDown={startRightTerminalResize}
                  >
                    <div className="absolute inset-0 bg-border-secondary group-hover:bg-interactive transition-colors" />
                    <div className="absolute -left-2 right-0 top-0 bottom-0" />
                  </div>

                  {/* Terminal header */}
                  <div className="pane-terminal-shell-header flex items-center h-8 px-3 bg-surface-primary border-b border-border-primary gap-2">
                    <Terminal className="w-3.5 h-3.5 text-text-tertiary" />
                    <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wider">Terminal</span>
                  </div>

                  {/* Terminal content - full height */}
                  <div className="pane-terminal-shell-body flex-1 relative min-h-0 pb-1">
                    <PanelContainer
                      panel={defaultTerminalPanel}
                      isActive={true}
                      isMainRepo={!!activeSession.isMainRepo}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* DEFAULT LAYOUT: Center column with panels on top, terminal on bottom */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Top: active panel content */}
                <div className="pane-editor-stage flex-1 relative min-h-0 overflow-hidden bg-bg-editor">
                  {sessionPanels.length > 0 && currentActivePanel ? (
                    sessionPanels
                      .filter(p => !defaultTerminalPanel || p.id !== defaultTerminalPanel.id)
                      .map(panel => {
                        const isActive = panel.id === currentActivePanel.id;
                        const shouldKeepAlive = ['terminal'].includes(panel.type);
                        if (!isActive && !shouldKeepAlive) return null;
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
                              isMainRepo={!!activeSession.isMainRepo}
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

                {/* Bottom: persistent terminal (collapsible) */}
                {defaultTerminalPanel && (
                  <div
                    className="pane-terminal-dock flex-shrink-0 border-t border-border-primary transition-[height] duration-200"
                    style={{ height: isTerminalCollapsed ? '32px' : `${terminalHeight}px` }}
                  >
                    {/* Terminal tab header with collapse toggle and pill shortcuts */}
                    <div className="pane-terminal-shell-header flex items-center h-8 px-3 bg-surface-primary border-b border-border-primary gap-2">
                      {/* Left: chevron + icon + label */}
                      <button
                        onClick={toggleTerminalCollapse}
                        className="p-0.5 hover:bg-surface-hover rounded transition-colors"
                        title={isTerminalCollapsed ? 'Expand terminal' : 'Collapse terminal'}
                      >
                        {isTerminalCollapsed ? (
                          <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />
                        )}
                      </button>
                      <Terminal className="w-3.5 h-3.5 text-text-tertiary" />
                      <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wider">Terminal</span>

                      {/* Middle: scrollable pill shortcuts */}
                      <div className="flex-1 flex items-center gap-2 overflow-x-auto ml-3 scrollbar-none">
                        {/* Claude pill */}
                        <Tooltip content={hotkeyDisplay('add-tool-terminal-claude') ? <Kbd>{hotkeyDisplay('add-tool-terminal-claude')}</Kbd> : undefined} side="top">
                          <button
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-text-tertiary border border-border-primary hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap flex-shrink-0"
                            onClick={() => handlePanelCreate('terminal', {
                              initialCommand: 'claude --dangerously-skip-permissions',
                              title: 'Claude Code'
                            })}
                          >
                            <ClaudeIcon className="w-3 h-3" />
                            Claude
                          </button>
                        </Tooltip>

                        {/* Codex pill */}
                        <Tooltip content={hotkeyDisplay('add-tool-terminal-codex') ? <Kbd>{hotkeyDisplay('add-tool-terminal-codex')}</Kbd> : undefined} side="top">
                          <button
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-text-tertiary border border-border-primary hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap flex-shrink-0"
                            onClick={() => handlePanelCreate('terminal', {
                              initialCommand: 'codex',
                              title: 'Codex'
                            })}
                          >
                            <OpenAIIcon className="w-3 h-3" />
                            Codex
                          </button>
                        </Tooltip>

                        {/* Custom command pills */}
                        {customCommands.map((cmd, index) => {
                          const shortcutDisplay = hotkeyDisplay(`add-tool-custom-${index}`);
                          const pill = (
                            <button
                              key={`shortcut-${index}`}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-text-tertiary border border-border-primary hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap flex-shrink-0"
                              onClick={() => handlePanelCreate('terminal', {
                                initialCommand: cmd.command,
                                title: cmd.name
                              })}
                              title={cmd.command}
                            >
                              {getCliBrandIcon(cmd.command, 'w-3 h-3') || <TerminalSquare className="w-3 h-3" />}
                              {cmd.name.length > 18 ? cmd.name.slice(0, 18) + '...' : cmd.name}
                            </button>
                          );
                          return shortcutDisplay ? (
                            <Tooltip key={`shortcut-${index}`} content={<Kbd>{shortcutDisplay}</Kbd>} side="top">
                              {pill}
                            </Tooltip>
                          ) : pill;
                        })}
                      </div>

                      {/* Right: resize grip (only when expanded, always outside scroll container) */}
                      {!isTerminalCollapsed && (
                        <div
                          className="ml-2 h-full flex items-center cursor-row-resize group flex-shrink-0"
                          onMouseDown={startTerminalResize}
                        />
                      )}
                    </div>
                    {/* Terminal content (hidden when collapsed) */}
                    {!isTerminalCollapsed && (
                      <div className="pane-terminal-shell-body relative pb-1" style={{ height: `calc(100% - 36px)` }}>
                        <PanelContainer
                          panel={defaultTerminalPanel}
                          isActive={true}
                          isMainRepo={!!activeSession.isMainRepo}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right: detail panel */}
              <DetailPanel
                isVisible={detailVisible}
                onToggle={() => setDetailVisible(v => !v)}
                width={detailWidth}
                onResize={startDetailResize}
                mergeError={hook.mergeError}
                onSwapLayout={toggleLayoutSwap}
                onCommitClick={handleCommitClick}
              />
            </>
          )}
        </div>

      </SessionProvider>

      <CommitMessageDialog
        isOpen={hook.showCommitMessageDialog}
        onClose={() => hook.setShowCommitMessageDialog(false)}
        dialogType={hook.dialogType}
        gitCommands={hook.gitCommands}
        commitMessage={hook.commitMessage}
        setCommitMessage={hook.setCommitMessage}
        shouldSquash={hook.shouldSquash}
        setShouldSquash={hook.setShouldSquash}
        onConfirm={(message) => {
          if (hook.dialogType === 'commit') {
            hook.handleGitStageAndCommit(message);
            hook.setShowCommitMessageDialog(false);
          } else {
            hook.performSquashWithCommitMessage(message);
          }
        }}
        onMergeAndArchive={hook.performSquashWithCommitMessageAndArchive}
        isMerging={hook.isMerging}
        isMergingAndArchiving={hook.isMergingAndArchiving}
      />

      <GitErrorDialog
        isOpen={hook.showGitErrorDialog}
        onClose={() => hook.setShowGitErrorDialog(false)}
        errorDetails={hook.gitErrorDetails}
        getGitErrorTips={hook.getGitErrorTips}
        onAbortAndUseClaude={hook.handleAbortRebaseAndUseClaude}
      />

      <ConfirmDialog
        isOpen={hook.showArchiveConfirm}
        onClose={() => hook.setShowArchiveConfirm(false)}
        onConfirm={hook.handleConfirmArchive}
        title="Archive Pane"
        message={`Archive pane "${activeSession?.name}"? This will:\n\n• Move the pane to the archived panes list\n• Preserve all pane history and outputs\n${activeSession?.isMainRepo ? '• Close the active Claude Code connection' : `• Remove the git worktree locally (${activeSession?.worktreePath?.split('/').pop() || 'worktree'})`}`}
        confirmText="Archive"
        variant="warning"
        icon={<Archive className="w-6 h-6 text-amber-500 flex-shrink-0" />}
      />

      <FolderArchiveDialog
        isOpen={hook.showFolderArchiveDialog}
        sessionCount={hook.folderSessionCount}
        onArchiveSessionOnly={hook.handleArchiveSessionOnly}
        onArchiveEntireFolder={hook.handleArchiveEntireFolder}
        onCancel={hook.handleCancelFolderArchive}
      />

      {/* Project Settings Dialog (opened from IDE dropdown) */}
      {sessionProject && (
        <ProjectSettings
          project={sessionProject}
          isOpen={showProjectSettings}
          onClose={() => setShowProjectSettings(false)}
          onUpdate={() => {
            // Refresh session project data
            if (activeSession?.projectId) {
              API.projects.getAll().then(response => {
                if (response.success && response.data) {
                  const project = response.data.find((p: Project) => p.id === activeSession.projectId);
                  if (project) setSessionProject(project);
                }
              });
            }
          }}
          onDelete={() => setShowProjectSettings(false)}
        />
      )}

      {/* Set Tracking Dialog */}
      {showSetTrackingDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-bg-primary border border-border-primary rounded-lg shadow-lg p-4 w-80 max-h-96 overflow-hidden flex flex-col">
            <h3 className="text-lg font-medium text-text-primary mb-2">Set Tracking Branch</h3>
            {currentUpstream && (
              <p className="text-sm text-text-secondary mb-3">
                Currently tracking: <span className="text-text-primary font-mono">{currentUpstream}</span>
              </p>
            )}
            <p className="text-sm text-text-secondary mb-3">Select a remote branch to track:</p>
            <div className="flex-1 overflow-y-auto space-y-1 mb-4">
              {remoteBranches.length === 0 ? (
                <p className="text-sm text-text-tertiary italic">No remote branches found</p>
              ) : (
                remoteBranches.map((branch) => (
                  <button
                    key={branch}
                    onClick={() => handleSelectUpstream(branch)}
                    className={`w-full text-left px-3 py-2 rounded text-sm font-mono hover:bg-bg-secondary transition-colors ${
                      branch === currentUpstream ? 'bg-bg-secondary text-accent-primary' : 'text-text-primary'
                    }`}
                  >
                    {branch}
                    {branch === currentUpstream && <span className="ml-2 text-xs">(current)</span>}
                  </button>
                ))
              )}
            </div>
            <button
              onClick={() => setShowSetTrackingDialog(false)}
              className="w-full px-4 py-2 text-sm text-text-secondary hover:text-text-primary border border-border-primary rounded hover:bg-bg-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

    </div>
  );
});

SessionView.displayName = 'SessionView';
