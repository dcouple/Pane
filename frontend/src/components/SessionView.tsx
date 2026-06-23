import { useRef, useEffect, useState, memo, useMemo, useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionHistoryStore } from '../stores/sessionHistoryStore';
import { useHotkey } from '../hooks/useHotkey';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { HomePage } from './HomePage';
import { PaneChatView } from './PaneChatView';
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
import { requestLocalReviewMode } from './panels/diff/reviewModePreference';
import { PanelTabBar } from './panels/PanelTabBar';
import { PanelContainer } from './panels/PanelContainer';
import { SplitLayout } from './panels/SplitLayout';
import { SessionProvider } from '../contexts/SessionContext';
import { ToolPanel, ToolPanelType, PANEL_CAPABILITIES, SessionPanelLayout, PanelGroupNode } from '../../../shared/types/panels';
import { PanelCreateOptions, type PanelTabPresentationResolver } from '../types/panelComponents';
import {
  createSingleGroupLayout,
  reconcile as reconcileLayout,
  splitGroup,
  movePanel as movePanelInLayout,
  removePanelFromLayout,
  addPanelToGroup,
  findGroup,
  primaryGroup,
  allGroups,
  allPanelIds,
  findGroupInDirection,
  updateSizes,
  findGroupContainingPanel,
  subsetInsertIndex,
  mergeAllGroups,
  type DropZone,
} from '../utils/panelLayout';
import { Download, Upload, GitMerge, GitPullRequestArrow, Terminal, ChevronDown, ChevronUp, RefreshCw, Archive, ArchiveRestore, GitCommitHorizontal, TerminalSquare, Undo2, X } from 'lucide-react';
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

const REVIEW_UNAVAILABLE_REASON = 'Open a PR for this branch to review changes';

function canSelectPanel(panel: ToolPanel | null | undefined, hasReviewPr: boolean): panel is ToolPanel {
  return !!panel && (panel.type !== 'diff' || hasReviewPr);
}

function pickDefaultPanel(panelList: ToolPanel[], hasReviewPr: boolean): ToolPanel | undefined {
  return (hasReviewPr ? panelList.find(p => p.type === 'diff') : undefined)
    || panelList.find(p => p.type === 'explorer')
    || panelList.find(p => p.type !== 'diff')
    || panelList[0];
}

function sanitizeReviewActivePanels(
  node: SessionPanelLayout['root'],
  panelById: Map<string, ToolPanel>,
  hasReviewPr: boolean
): SessionPanelLayout['root'] {
  if (hasReviewPr) return node;

  if (node.type === 'group') {
    const activePanel = node.activePanelId ? panelById.get(node.activePanelId) : undefined;
    if (activePanel?.type !== 'diff') return node;

    const fallback = node.panelIds
      .map(id => panelById.get(id))
      .find((panel): panel is ToolPanel => !!panel && panel.type !== 'diff');

    return { ...node, activePanelId: fallback?.id ?? null };
  }

  return { ...node, children: node.children.map(child => sanitizeReviewActivePanels(child, panelById, hasReviewPr)) };
}

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
  const { config, fetchConfig, updateConfig } = useConfigStore();
  useEffect(() => { if (!config) { fetchConfig(); } }, [config, fetchConfig]);
  const customCommands = useMemo(
    () => (config?.customCommands ?? []).filter(cmd => cmd?.name && cmd?.command),
    [config?.customCommands]
  );
  const isRemoteMode = config?.remoteDaemon?.client.mode === 'remote';
  const deleteCustomCommand = useCallback((index: number) => {
    const existing = config?.customCommands ?? [];
    updateConfig({ customCommands: existing.filter((_, i) => i !== index) }).catch(() => {});
  }, [config, updateConfig]);

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
    layouts,
    focusedGroupIds,
    setLayout: setLayoutInStore,
    setFocusedGroup: setFocusedGroupInStore,
  } = usePanelStore();
  
  // History store for navigation
  const { addToHistory } = useSessionHistoryStore();

  // --- Layout debounced persist ---
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLayoutRef = useRef<{ sessionId: string; layout: SessionPanelLayout } | null>(null);

  const flushLayoutPersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const pending = pendingLayoutRef.current;
    if (pending) {
      pendingLayoutRef.current = null;
      panelApi.setLayout(pending.sessionId, pending.layout).catch(err => {
        console.warn('[SessionView] Failed to persist layout:', err);
      });
    }
  }, []);

  const debouncedPersist = useCallback((sessionId: string, layout: SessionPanelLayout) => {
    pendingLayoutRef.current = { sessionId, layout };
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(flushLayoutPersist, 500);
  }, [flushLayoutPersist]);

  // Flush a pending layout write before the window closes: the debounce would
  // otherwise lose a split made just before quit.
  useEffect(() => {
    window.addEventListener('beforeunload', flushLayoutPersist);
    return () => window.removeEventListener('beforeunload', flushLayoutPersist);
  }, [flushLayoutPersist]);

  // --- Layout application helper ---
  // Self-healing: every mutation funnels through here, so focus and zoom are
  // repaired centrally instead of in each caller. A collapse that removed the
  // focused group falls back to the primary group; a dead zoom target clears.
  const applyLayout = useCallback((sessionId: string, next: SessionPanelLayout) => {
    let focusedGid = next.focusedGroupId;
    if (!focusedGid || !findGroup(next.root, focusedGid)) {
      focusedGid = primaryGroup(next.root).id;
    }
    let zoomedGid = next.zoomedGroupId && findGroup(next.root, next.zoomedGroupId)
      ? next.zoomedGroupId
      : null;
    if (zoomedGid) {
      // Any structural change (group added/removed) exits zoom, matching
      // VS Code: a split or drop while zoomed would otherwise land panels in
      // a pane that Allotment keeps hidden.
      const prev = usePanelStore.getState().layouts[sessionId];
      if (prev) {
        const prevGroupIds = allGroups(prev.root).map(g => g.id).join('|');
        const nextGroupIds = allGroups(next.root).map(g => g.id).join('|');
        if (prevGroupIds !== nextGroupIds) zoomedGid = null;
      }
      // Zoom follows focus: moving focus off the zoomed group (directional
      // nav can target hidden groups) exits zoom instead of typing blind.
      if (zoomedGid && focusedGid !== zoomedGid) zoomedGid = null;
    }
    const repaired: SessionPanelLayout = { ...next, focusedGroupId: focusedGid, zoomedGroupId: zoomedGid };

    setLayoutInStore(sessionId, repaired);
    setFocusedGroupInStore(sessionId, focusedGid);
    debouncedPersist(sessionId, repaired);

    // Mirror focused panel to activePanels for existing compatibility
    const g = findGroup(repaired.root, focusedGid);
    if (g?.activePanelId) {
      const currentActive = usePanelStore.getState().activePanels[sessionId];
      if (g.activePanelId !== currentActive) {
        setActivePanelInStore(sessionId, g.activePanelId);
        panelApi.setActivePanel(sessionId, g.activePanelId).catch(() => {});
      }
    }
  }, [setLayoutInStore, setFocusedGroupInStore, debouncedPersist, setActivePanelInStore]);

  // Load panels AND layout when session changes
  useEffect(() => {
    if (activeSession?.id) {
      const sid = activeSession.id;
      devLog.debug('[SessionView] Loading panels for session:', sid);

      // Flush any pending layout from the previous session
      flushLayoutPersist();

      // Snapshot the ids present BEFORE the async load: a panel:created event
      // landing during the load adds its panel to the store, and a plain
      // setPanels(loadedPanels) overwrite would erase it again. Panels that
      // appeared mid-flight (in the store now, absent from both the snapshot
      // and the response) are merged back in.
      const preLoadIds = new Set(
        (usePanelStore.getState().panels[sid] || []).map(p => p.id)
      );

      // Always reload panels from database when switching sessions
      panelApi.loadPanelsForSession(sid).then(async loadedPanels => {
        devLog.debug('[SessionView] Loaded panels:', loadedPanels);
        const hasReviewPr = !!activeSession.gitStatus?.prUrl;
        const inFlight = (usePanelStore.getState().panels[sid] || []).filter(
          p => !preLoadIds.has(p.id) && !loadedPanels.some(lp => lp.id === p.id)
        );
        setPanels(sid, inFlight.length > 0 ? [...loadedPanels, ...inFlight] : loadedPanels);

        // Pick default active: Review is only selectable once a PR is known.
        const fallback = pickDefaultPanel(loadedPanels, hasReviewPr);

        const activePanelResult = await panelApi.getActivePanel(sid);
        const effectiveActivePanel = canSelectPanel(activePanelResult, hasReviewPr)
          ? activePanelResult
          : fallback;
        const fallbackActiveId = effectiveActivePanel?.id ?? null;

        if (effectiveActivePanel) {
          setActivePanelInStore(sid, effectiveActivePanel.id);
          if (activePanelResult?.id !== effectiveActivePanel.id) {
            panelApi.setActivePanel(sid, effectiveActivePanel.id).catch(() => {});
          }
        }

        // --- Layout load + reconcile ---
        // The pinned terminal (first terminal) is excluded from the layout tree
        const pinned = loadedPanels.find(p => p.type === 'terminal');
        const livePanels = pinned ? loadedPanels.filter(p => p.id !== pinned.id) : loadedPanels;

        // Sort for initial layout creation (explorer first, diff second, then position)
        const typeOrder = (type: string) => {
          if (type === 'explorer') return 0;
          if (type === 'diff') return 1;
          return 2;
        };
        const sortedLive = [...livePanels].sort((a, b) => {
          const orderDiff = typeOrder(a.type) - typeOrder(b.type);
          if (orderDiff !== 0) return orderDiff;
          return (a.metadata?.position ?? 0) - (b.metadata?.position ?? 0);
        });

        try {
          const stored = await panelApi.getLayout(sid);
          // Recompute live ids from the store at set time: panel:created
          // events that landed while this load was in flight are in the store
          // but not in the loadedPanels snapshot. Reconciling against the
          // current store adopts them as orphans instead of dropping them.
          const nowPanels = usePanelStore.getState().panels[sid] || [];
          const pinnedNow = nowPanels.find(p => p.type === 'terminal');
          const liveIdsNow = (pinnedNow ? nowPanels.filter(p => p.id !== pinnedNow.id) : nowPanels)
            .map(p => p.id);
          // Treat unknown future layout versions as no stored layout rather
          // than reconciling a shape this build doesn't understand.
          const versionOk = stored?.version === 1;
          const base = (versionOk ? stored : null) ?? createSingleGroupLayout(
            sortedLive.map(p => p.id),
            fallbackActiveId,
          );
          const { layout } = reconcileLayout(base, liveIdsNow);
          const panelById = new Map(nowPanels.map(panel => [panel.id, panel]));
          const safeRoot = sanitizeReviewActivePanels(layout.root, panelById, hasReviewPr);
          const safeLayout = safeRoot === layout.root ? layout : { ...layout, root: safeRoot };
          setLayoutInStore(sid, safeLayout);
          setFocusedGroupInStore(sid, safeLayout.focusedGroupId ?? primaryGroup(safeLayout.root).id);
        } catch (err) {
          console.warn('[SessionView] Failed to load layout, creating default:', err);
          const layout = createSingleGroupLayout(
            sortedLive.map(p => p.id),
            fallbackActiveId,
          );
          const panelById = new Map(loadedPanels.map(panel => [panel.id, panel]));
          const safeRoot = sanitizeReviewActivePanels(layout.root, panelById, hasReviewPr);
          const safeLayout = safeRoot === layout.root ? layout : { ...layout, root: safeRoot };
          setLayoutInStore(sid, safeLayout);
          setFocusedGroupInStore(sid, safeLayout.focusedGroupId ?? primaryGroup(safeLayout.root).id);
        }
      });
    }

    // Flush layout on cleanup (session switch or unmount)
    return () => {
      flushLayoutPersist();
    };
  }, [activeSession?.id, activeSession?.gitStatus?.prUrl, setPanels, setActivePanelInStore, setLayoutInStore, setFocusedGroupInStore, flushLayoutPersist]);
  
  // Listen for panel updates from the backend
  useEffect(() => {
    if (!activeSession?.id) return;
    const sid = activeSession.id;

    // Handle panel creation events (for logs panel auto-creation)
    const handlePanelCreated = (panel: ToolPanel) => {
      // Only add if it's for the current session
      if (panel.sessionId === sid) {
        const existingPanels = panels[sid] || [];
        const panelExists = existingPanels.some(p => p.id === panel.id);

        if (!panelExists) {
          addPanel(panel);

          // The pinned terminal (first terminal in the session) never enters
          // the layout tree
          const sessionPanelsList = usePanelStore.getState().panels[sid] || [];
          const pinnedTerminal = sessionPanelsList.find(p => p.type === 'terminal');
          if (pinnedTerminal && panel.id === pinnedTerminal.id) {
            return;
          }

          // Add the new panel to the layout (into the focused group, falling
          // back to the primary group if focus is stale). addPanelToGroup is
          // idempotent, so racing with handlePanelCreate cannot double-insert.
          const currentLayout = usePanelStore.getState().layouts[sid];
          if (currentLayout) {
            const focusedGid = usePanelStore.getState().focusedGroupIds[sid];
            const group = (focusedGid && findGroup(currentLayout.root, focusedGid))
              || primaryGroup(currentLayout.root);
            const nextRoot = addPanelToGroup(currentLayout.root, group.id, panel.id, {
              activate: panel.state.isActive,
            });
            if (nextRoot !== currentLayout.root) {
              applyLayout(sid, { ...currentLayout, root: nextRoot });
            }
          }
        }
      }
    };

    const handlePanelUpdated = (updatedPanel: ToolPanel) => {
      if (updatedPanel.sessionId === sid) {
        updatePanelState(updatedPanel);
      }
    };

    // Handle panel deletion events (for backend-initiated deletes)
    const handlePanelDeleted = (data: { panelId: string; sessionId: string }) => {
      if (data.sessionId === sid) {
        removePanel(sid, data.panelId);
        // Reconcile layout. A null result means the tree collapsed entirely;
        // keep one empty group so later creates have a landing spot.
        const currentLayout = usePanelStore.getState().layouts[sid];
        if (currentLayout) {
          const updated = removePanelFromLayout(currentLayout.root, data.panelId);
          const next: SessionPanelLayout = updated
            ? { ...currentLayout, root: updated }
            : { ...createSingleGroupLayout([], null), zoomedGroupId: null };
          applyLayout(sid, next);
        }
      }
    };

    // Listen for panel events
    const unsubscribeCreated = window.electronAPI?.events?.onPanelCreated?.(handlePanelCreated);
    const unsubscribeUpdated = window.electronAPI?.events?.onPanelUpdated?.(handlePanelUpdated);
    const unsubscribeDeleted = window.electronAPI?.events?.onPanelDeleted?.(handlePanelDeleted);

    // Cleanup
    return () => {
      unsubscribeCreated?.();
      unsubscribeUpdated?.();
      unsubscribeDeleted?.();
    };
  }, [activeSession?.id, addPanel, updatePanelState, removePanel, panels, applyLayout]);

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

  // Sort tab bar panels same as PanelTabBar: explorer first, diff second, then by position
  const sortedSessionPanels = useMemo(() => {
    const typeOrder = (type: string) => {
      if (type === 'explorer') return 0;
      if (type === 'diff') return 1;
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

  // --- Layout-derived memos ---
  const sessionLayout = useMemo(
    () => layouts[activeSession?.id || ''],
    [layouts, activeSession?.id]
  );
  const focusedGroupId = useMemo(
    () => focusedGroupIds[activeSession?.id || ''] ?? '',
    [focusedGroupIds, activeSession?.id]
  );
  const focusedGroup: PanelGroupNode | null = useMemo(
    () => sessionLayout ? findGroup(sessionLayout.root, focusedGroupId) : null,
    [sessionLayout, focusedGroupId]
  );
  /** Panels in the focused group, in layout order. */
  const focusedGroupPanels = useMemo(() => {
    if (!focusedGroup) return sortedSessionPanels;
    const panelMap = new Map(tabBarPanels.map(p => [p.id, p]));
    return focusedGroup.panelIds.map(id => panelMap.get(id)).filter((p): p is ToolPanel => !!p);
  }, [focusedGroup, tabBarPanels, sortedSessionPanels]);
  /** Primary group panels (for PanelTabBar tab strip). */
  const primaryGroupNode = useMemo(
    () => sessionLayout ? primaryGroup(sessionLayout.root) : null,
    [sessionLayout]
  );
  const primaryGroupPanels = useMemo(() => {
    if (!primaryGroupNode) return undefined; // undefined means PanelTabBar uses its own sort
    const panelMap = new Map(tabBarPanels.map(p => [p.id, p]));
    return primaryGroupNode.panelIds.map(id => panelMap.get(id)).filter((p): p is ToolPanel => !!p);
  }, [primaryGroupNode, tabBarPanels]);
  const isSplitLayout = sessionLayout?.root.type === 'split';
  /** What the top bar shows: everything when unsplit; once split, the
      permanent tool tabs hoisted from EVERY group (in reading order), so the
      defaults stay pinned to the top bar no matter which group owns them.
      Clicking one routes to its owning group via handlePanelSelect. */
  const topBarPanels = useMemo(() => {
    if (!primaryGroupPanels) return undefined;
    if (!isSplitLayout || !sessionLayout) return primaryGroupPanels;
    const panelMap = new Map(tabBarPanels.map(p => [p.id, p]));
    return allPanelIds(sessionLayout.root)
      .map(id => panelMap.get(id))
      .filter((p): p is ToolPanel => !!p && p.metadata?.permanent === true);
  }, [primaryGroupPanels, isSplitLayout, sessionLayout, tabBarPanels]);

  const getPanelTabPresentation = useCallback<PanelTabPresentationResolver>((panel) => {
    if (panel.type !== 'diff') return undefined;
    const hasReviewPr = !!activeSession?.gitStatus?.prUrl;
    return {
      title: 'Review',
      disabled: !hasReviewPr,
      disabledReason: hasReviewPr ? undefined : REVIEW_UNAVAILABLE_REASON,
    };
  }, [activeSession?.gitStatus?.prUrl]);

  // --- Drag & drop state ---
  const [draggedPanelId, setDraggedPanelId] = useState<string | null>(null);
  const [dropZones, setDropZones] = useState<Map<string, DropZone | null>>(new Map());
  const isTabDragging = draggedPanelId !== null;

  // When a split or cross-group move takes a group's ACTIVE panel away, the
  // pure layer falls back to the first remaining id, which is usually a
  // permanent tab (Diff). Prefer the first working tab instead: when split,
  // permanent tabs live in the top bar, so a group flipping to the Diff view
  // under a terminal strip reads as wrong. Callers gate on the moved panel
  // having been the group's active so a deliberately-active Diff stays put.
  const preferWorkingActive = useCallback((
    root: SessionPanelLayout['root'],
    sourceGroupId: string | undefined,
  ): SessionPanelLayout['root'] => {
    if (!sourceGroupId || !activeSession) return root;
    const g = findGroup(root, sourceGroupId);
    if (!g || !g.activePanelId) return root;
    const panelMap = new Map(
      (usePanelStore.getState().panels[activeSession.id] || []).map(p => [p.id, p])
    );
    if (panelMap.get(g.activePanelId)?.metadata?.permanent !== true) return root;
    const firstWorking = g.panelIds.find(id => panelMap.get(id)?.metadata?.permanent !== true);
    if (!firstWorking) return root;
    const nextActive: string = firstWorking;
    function fix(node: SessionPanelLayout['root']): SessionPanelLayout['root'] {
      if (node.type === 'group') {
        return node.id === sourceGroupId ? { ...node, activePanelId: nextActive } : node;
      }
      return { ...node, children: node.children.map(fix) };
    }
    return fix(root);
  }, [activeSession]);

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

  // --- Layout-aware panel select ---
  const handleGroupPanelSelect = useCallback(
    (groupId: string, panel: ToolPanel) => {
      if (!activeSession) return;
      if (panel.type === 'diff' && !activeSession.gitStatus?.prUrl) return;
      const sid = activeSession.id;
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (!currentLayout) return;

      // Update the group's activePanelId
      function setGroupActive(node: SessionPanelLayout['root']): SessionPanelLayout['root'] {
        if (node.type === 'group' && node.id === groupId) {
          return { ...node, activePanelId: panel.id };
        }
        if (node.type === 'split') {
          return { ...node, children: node.children.map(setGroupActive) };
        }
        return node;
      }
      const next: SessionPanelLayout = {
        ...currentLayout,
        root: setGroupActive(currentLayout.root),
        focusedGroupId: groupId,
      };
      applyLayout(sid, next);
      setFocusedGroupInStore(sid, groupId);
      addToHistory(sid, panel.id);
    },
    [activeSession, applyLayout, setFocusedGroupInStore, addToHistory]
  );

  // FIX: Memoize all callbacks to prevent re-renders
  const handlePanelSelect = useCallback(
    async (panel: ToolPanel) => {
      if (!activeSession) return;
      if (panel.type === 'diff' && !activeSession.gitStatus?.prUrl) return;

      // Add to history when panel is selected
      addToHistory(activeSession.id, panel.id);

      // If layout exists, find which group contains this panel and update it
      const currentLayout = usePanelStore.getState().layouts[activeSession.id];
      if (currentLayout) {
        const group = findGroupContainingPanel(currentLayout.root, panel.id);
        if (group) {
          handleGroupPanelSelect(group.id, panel);
          return;
        }
      }

      setActivePanelInStore(activeSession.id, panel.id);
      await panelApi.setActivePanel(activeSession.id, panel.id);
    },
    [activeSession, setActivePanelInStore, addToHistory, handleGroupPanelSelect]
  );

  const handleCommitClick = useCallback(
    async (commitHash: string) => {
      if (!activeSession || sessionPanels.length === 0) return;
      if (!activeSession.gitStatus?.prUrl) return;
      const diffPanel = sessionPanels.find(p => p.type === 'diff');
      if (!diffPanel) return;
      // Store pending hash before dispatching — if the diff panel is not
      // currently active, CombinedDiffView is unmounted and will read this
      // module-level variable when it mounts after the panel switch.
      setPendingViewCommit(activeSession.id, commitHash);
      requestLocalReviewMode(activeSession.id);
      await handlePanelSelect(diffPanel);
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('diff:view-commit', {
          detail: { sessionId: activeSession.id, commitHash },
        }));
      }, 0);
    },
    [activeSession, sessionPanels, handlePanelSelect]
  );

  // Tab cycling: navigates between panels in the focused group using
  // keyboard shortcuts. Supports wrap-around (last → first). Only enabled
  // when there are 2+ panels. Uses focusedGroupPanels (layout order).
  const cycleTab = useCallback((direction: 'next' | 'prev') => {
    if (!activeSession || focusedGroupPanels.length < 2) return;

    const currentIndex = focusedGroupPanels.findIndex(
      p => p.id === currentActivePanel?.id
    );
    const nextIndex = cycleIndex(currentIndex, focusedGroupPanels.length, direction);
    if (nextIndex === -1) return;

    const nextPanel = focusedGroupPanels[nextIndex];
    handlePanelSelect(nextPanel);
  }, [activeSession, focusedGroupPanels, currentActivePanel, handlePanelSelect]);

  // Tab cycling hotkeys
  useHotkey({
    id: 'cycle-tab-prev-a',
    label: 'Previous Tab',
    keys: 'mod+a',
    category: 'tabs',
    enabled: () => focusedGroupPanels.length > 1,
    action: () => cycleTab('prev'),
    showInPalette: true,
  });

  useHotkey({
    id: 'cycle-tab-next-d',
    label: 'Next Tab',
    keys: 'mod+d',
    category: 'tabs',
    enabled: () => focusedGroupPanels.length > 1,
    action: () => cycleTab('next'),
    showInPalette: true,
  });

  // Mod+Shift+1 through Mod+Shift+9 to switch between panel tabs (focused group scoped)
  const panelLabel = (i: number) => {
    const p = focusedGroupPanels[i];
    if (!p) return `Switch to tab ${i + 1}`;
    const name = p.type === 'diff' ? 'Review' : p.title;
    return `Switch to ${name}`;
  };
  useHotkey({ id: 'panel-tab-1', label: panelLabel(0), keys: 'mod+shift+1', category: 'tabs', enabled: () => !!focusedGroupPanels[0], action: () => { const p = focusedGroupPanels[0]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-2', label: panelLabel(1), keys: 'mod+shift+2', category: 'tabs', enabled: () => !!focusedGroupPanels[1], action: () => { const p = focusedGroupPanels[1]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-3', label: panelLabel(2), keys: 'mod+shift+3', category: 'tabs', enabled: () => !!focusedGroupPanels[2], action: () => { const p = focusedGroupPanels[2]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-4', label: panelLabel(3), keys: 'mod+shift+4', category: 'tabs', enabled: () => !!focusedGroupPanels[3], action: () => { const p = focusedGroupPanels[3]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-5', label: panelLabel(4), keys: 'mod+shift+5', category: 'tabs', enabled: () => !!focusedGroupPanels[4], action: () => { const p = focusedGroupPanels[4]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-6', label: panelLabel(5), keys: 'mod+shift+6', category: 'tabs', enabled: () => !!focusedGroupPanels[5], action: () => { const p = focusedGroupPanels[5]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-7', label: panelLabel(6), keys: 'mod+shift+7', category: 'tabs', enabled: () => !!focusedGroupPanels[6], action: () => { const p = focusedGroupPanels[6]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-8', label: panelLabel(7), keys: 'mod+shift+8', category: 'tabs', enabled: () => !!focusedGroupPanels[7], action: () => { const p = focusedGroupPanels[7]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-9', label: panelLabel(8), keys: 'mod+shift+9', category: 'tabs', enabled: () => !!focusedGroupPanels[8], action: () => { const p = focusedGroupPanels[8]; if (p) handlePanelSelect(p); } });

  // --- Add Tool commands (palette-only, no keybindings) ---
  // Only enabled in session view (not project view) to prevent hidden panel mutations
  const isInSessionView = !!activeSession && activeView === 'sessions';

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
      initialCommand: 'codex --yolo',
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

  // --- Split tab group hotkeys ---
  // Mod+\: split right (move active tab to a new group to the right)
  useHotkey({
    id: 'split-right',
    label: 'Split Right',
    keys: 'mod+\\',
    category: 'tabs',
    enabled: () => {
      if (!activeSession || !focusedGroup) return false;
      return focusedGroup.panelIds.length >= 2 && !!focusedGroup.activePanelId;
    },
    action: () => {
      if (!activeSession || !focusedGroup || !focusedGroup.activePanelId) return;
      const sid = activeSession.id;
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (!currentLayout) return;
      const newRoot = preferWorkingActive(
        splitGroup(currentLayout.root, focusedGroup.id, focusedGroup.activePanelId, 'row', true),
        focusedGroup.id,
      );
      // Find the new group (the one containing the moved panel)
      const newGroup = findGroupContainingPanel(newRoot, focusedGroup.activePanelId);
      const next: SessionPanelLayout = {
        ...currentLayout,
        root: newRoot,
        focusedGroupId: newGroup?.id ?? currentLayout.focusedGroupId,
      };
      applyLayout(sid, next);
      if (newGroup) {
        setFocusedGroupInStore(sid, newGroup.id);
      }
    },
    showInPalette: true,
  });

  // Mod+Shift+\: split down
  useHotkey({
    id: 'split-down',
    label: 'Split Down',
    keys: 'mod+shift+\\',
    category: 'tabs',
    enabled: () => {
      if (!activeSession || !focusedGroup) return false;
      return focusedGroup.panelIds.length >= 2 && !!focusedGroup.activePanelId;
    },
    action: () => {
      if (!activeSession || !focusedGroup || !focusedGroup.activePanelId) return;
      const sid = activeSession.id;
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (!currentLayout) return;
      const newRoot = preferWorkingActive(
        splitGroup(currentLayout.root, focusedGroup.id, focusedGroup.activePanelId, 'column', true),
        focusedGroup.id,
      );
      const newGroup = findGroupContainingPanel(newRoot, focusedGroup.activePanelId);
      const next: SessionPanelLayout = {
        ...currentLayout,
        root: newRoot,
        focusedGroupId: newGroup?.id ?? currentLayout.focusedGroupId,
      };
      applyLayout(sid, next);
      if (newGroup) {
        setFocusedGroupInStore(sid, newGroup.id);
      }
    },
    showInPalette: true,
  });

  // Mod+Alt+Arrows: directional group focus
  useHotkey({
    id: 'focus-group-left',
    label: 'Focus Group Left',
    keys: 'mod+alt+ArrowLeft',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const target = findGroupInDirection(sessionLayout.root, focusedGroupId, 'left');
      if (target) handleFocusGroup(target);
    },
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-group-right',
    label: 'Focus Group Right',
    keys: 'mod+alt+ArrowRight',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const target = findGroupInDirection(sessionLayout.root, focusedGroupId, 'right');
      if (target) handleFocusGroup(target);
    },
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-group-up',
    label: 'Focus Group Up',
    keys: 'mod+alt+ArrowUp',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const target = findGroupInDirection(sessionLayout.root, focusedGroupId, 'up');
      if (target) handleFocusGroup(target);
    },
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-group-down',
    label: 'Focus Group Down',
    keys: 'mod+alt+ArrowDown',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const target = findGroupInDirection(sessionLayout.root, focusedGroupId, 'down');
      if (target) handleFocusGroup(target);
    },
    showInPalette: true,
  });

  // Mod+Shift+Z: zoom toggle
  useHotkey({
    id: 'zoom-toggle',
    label: 'Toggle Zoom',
    keys: 'mod+shift+z',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const sid = activeSession.id;
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (!currentLayout) return;
      const isZoomed = !!currentLayout.zoomedGroupId;
      const next: SessionPanelLayout = {
        ...currentLayout,
        zoomedGroupId: isZoomed ? null : focusedGroupId,
      };
      applyLayout(sid, next);
    },
    showInPalette: true,
  });

  const handlePanelClose = useCallback(
    async (panel: ToolPanel) => {
      if (!activeSession) return;
      const sid = activeSession.id;

      // Remove from store first for immediate UI update
      removePanel(sid, panel.id);

      // Update layout: remove the panel and pick next active. A null result
      // means the tree collapsed entirely; keep one empty group so later
      // creates have a landing spot (applyLayout repairs focus).
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (currentLayout) {
        // Find which group had this panel to pick a neighbor
        const group = findGroupContainingPanel(currentLayout.root, panel.id);
        const updated = removePanelFromLayout(currentLayout.root, panel.id);
        if (updated) {
          const next: SessionPanelLayout = { ...currentLayout, root: updated };
          // Pick a successor only when the closed panel WAS the group's
          // active tab; closing a background tab keeps the current one
          // (matching VS Code).
          if (group && group.activePanelId === panel.id) {
            const remainingInGroup = group.panelIds.filter(id => id !== panel.id);
            const panelIndex = group.panelIds.indexOf(panel.id);
            const nextInGroup = remainingInGroup[Math.min(panelIndex, remainingInGroup.length - 1)];
            if (nextInGroup) {
              // Update the group's activePanelId
              function fixActive(node: SessionPanelLayout['root']): SessionPanelLayout['root'] {
                if (node.type === 'group' && node.id === group!.id) {
                  return { ...node, activePanelId: nextInGroup };
                }
                if (node.type === 'split') {
                  return { ...node, children: node.children.map(fixActive) };
                }
                return node;
              }
              next.root = fixActive(next.root);
            }
          }
          applyLayout(sid, next);
        } else {
          applyLayout(sid, { ...createSingleGroupLayout([], null), zoomedGroupId: null });
        }
      } else {
        // Fallback: no layout, use old logic
        const panelIndex = sessionPanels.findIndex(p => p.id === panel.id);
        const nextPanel = sessionPanels[panelIndex + 1] || sessionPanels[panelIndex - 1];
        if (nextPanel) {
          setActivePanelInStore(sid, nextPanel.id);
          await panelApi.setActivePanel(sid, nextPanel.id);
        }
      }

      // Delete on backend
      await panelApi.deletePanel(panel.id);
    },
    [activeSession, sessionPanels, removePanel, setActivePanelInStore, applyLayout]
  );

  const handlePanelCreate = useCallback(
    async (type: ToolPanelType, options?: PanelCreateOptions) => {
      if (!activeSession) return;
      const sid = activeSession.id;

      // For terminal panels with initialCommand (e.g., Terminal (Claude))
      let initialState: { customState?: unknown } | undefined = undefined;
      if (type === 'terminal' && options?.initialCommand) {
        initialState = {
          customState: {
            initialCommand: options.initialCommand
          }
        };
      }

      // Captured BEFORE the create: if the session has no terminal yet, the
      // panel we are about to create becomes the pinned dock terminal and
      // must never enter the layout tree.
      const hadTerminalBefore = (usePanelStore.getState().panels[sid] || [])
        .some(p => p.type === 'terminal');

      const newPanel = await panelApi.createPanel({
        sessionId: sid,
        type,
        title: options?.title,
        initialState
      });

      // Immediately add the panel and set it as active
      addPanel(newPanel);
      setActivePanelInStore(sid, newPanel.id);

      const becomesPinnedTerminal = type === 'terminal' && !hadTerminalBefore;
      if (becomesPinnedTerminal) return;

      // Add to layout (into the focused group, falling back to the primary
      // group if focus is stale). addPanelToGroup is idempotent, so racing
      // with the panel:created event handler cannot double-insert.
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (currentLayout) {
        const focusedGid = usePanelStore.getState().focusedGroupIds[sid];
        const targetGroup = (focusedGid && findGroup(currentLayout.root, focusedGid))
          || primaryGroup(currentLayout.root);
        const nextRoot = addPanelToGroup(currentLayout.root, targetGroup.id, newPanel.id);
        if (nextRoot !== currentLayout.root) {
          applyLayout(sid, { ...currentLayout, root: nextRoot });
        }
      }
    },
    [activeSession, addPanel, setActivePanelInStore, applyLayout]
  );

  // --- SplitLayout callbacks ---
  const handleSizesChange = useCallback((splitNodeId: string, sizes: number[]) => {
    if (!activeSession) return;
    const sid = activeSession.id;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (!currentLayout) return;
    // Allotment re-layouts when panes hide/show for zoom; those geometries
    // are transient (the hidden pane reports a collapsed size) and must not
    // be persisted or a restart-while-zoomed restores a sliver.
    if (currentLayout.zoomedGroupId) return;
    const next: SessionPanelLayout = { ...currentLayout, root: updateSizes(currentLayout.root, splitNodeId, sizes) };
    applyLayout(sid, next);
  }, [activeSession, applyLayout]);

  const handleFocusGroup = useCallback((groupId: string) => {
    if (!activeSession) return;
    const sid = activeSession.id;
    // No-op when already focused: this fires on every mousedown inside a
    // group (capture phase), and re-applying focus would schedule a layout
    // persist and an IPC write per click.
    if (usePanelStore.getState().focusedGroupIds[sid] === groupId) return;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (currentLayout) {
      const group = findGroup(currentLayout.root, groupId);
      const panel = group?.activePanelId
        ? usePanelStore.getState().panels[sid]?.find(candidate => candidate.id === group.activePanelId)
        : undefined;
      if (panel?.type === 'diff' && !activeSession.gitStatus?.prUrl) return;
      if (group?.activePanelId) {
        setActivePanelInStore(sid, group.activePanelId);
        panelApi.setActivePanel(sid, group.activePanelId).catch(() => {});
      }
      // applyLayout syncs focusedGroupIds in the store
      const next: SessionPanelLayout = { ...currentLayout, focusedGroupId: groupId };
      applyLayout(sid, next);
    } else {
      setFocusedGroupInStore(sid, groupId);
    }
  }, [activeSession, setFocusedGroupInStore, setActivePanelInStore, applyLayout]);

  const handleDropZoneChange = useCallback((groupId: string, zone: DropZone | null) => {
    setDropZones(prev => {
      const next = new Map(prev);
      if (zone === null) next.delete(groupId);
      else next.set(groupId, zone);
      return next;
    });
  }, []);

  const handleDropTab = useCallback((groupId: string, zone: DropZone) => {
    if (!activeSession || !draggedPanelId) return;
    const sid = activeSession.id;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (!currentLayout) return;

    // No-op: dropping onto own group center
    const sourceGroup = findGroupContainingPanel(currentLayout.root, draggedPanelId);
    if (zone === 'center' && sourceGroup?.id === groupId) {
      setDraggedPanelId(null);
      setDropZones(new Map());
      return;
    }
    // No-op: dropping the only tab of a group onto an edge of the same group
    if (sourceGroup?.id === groupId && sourceGroup?.panelIds.length === 1) {
      setDraggedPanelId(null);
      setDropZones(new Map());
      return;
    }

    let newRoot: SessionPanelLayout['root'];
    if (zone === 'center') {
      const targetGroup = findGroup(currentLayout.root, groupId);
      const insertIdx = targetGroup ? targetGroup.panelIds.length : 0;
      newRoot = movePanelInLayout(currentLayout.root, draggedPanelId, { groupId, index: insertIdx });
    } else {
      newRoot = movePanelInLayout(currentLayout.root, draggedPanelId, { groupId, edge: zone });
    }
    if (sourceGroup && sourceGroup.activePanelId === draggedPanelId) {
      newRoot = preferWorkingActive(newRoot, sourceGroup.id);
    }

    const next: SessionPanelLayout = { ...currentLayout, root: newRoot };
    applyLayout(sid, next);
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, [activeSession, draggedPanelId, applyLayout, preferWorkingActive]);

  const handleDragStart = useCallback((panelId: string) => {
    setDraggedPanelId(panelId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, []);

  const handleStripDrop = useCallback((groupId: string, panelId: string, insertIndex: number) => {
    if (!activeSession) return;
    const sid = activeSession.id;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (!currentLayout) return;

    const sourceGroup = findGroupContainingPanel(currentLayout.root, panelId);
    let newRoot = movePanelInLayout(currentLayout.root, panelId, { groupId, index: insertIndex });
    if (sourceGroup && sourceGroup.id !== groupId && sourceGroup.activePanelId === panelId) {
      newRoot = preferWorkingActive(newRoot, sourceGroup.id);
    }
    const next: SessionPanelLayout = { ...currentLayout, root: newRoot };
    applyLayout(sid, next);
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, [activeSession, applyLayout, preferWorkingActive]);

  // Top-bar drops are the un-split gesture: merge every group back into the
  // primary group and place the dropped tab at the indicated position. When
  // the pane isn't split, the merge is the identity and this is a plain
  // reorder. The top bar shows only the permanent subset while split, so its
  // drop indexes translate to the group's full panel order first.
  const primaryGroupId = primaryGroupNode?.id;
  const handlePrimaryStripDrop = useCallback((panelId: string, insertIndex: number) => {
    if (!primaryGroupId || !primaryGroupNode || !activeSession) return;
    const sid = activeSession.id;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (!currentLayout) return;
    const merged = mergeAllGroups(currentLayout.root);
    // The top bar shows the hoisted permanent subset while split; translate
    // its drop index against the merged (post-un-split) panel order.
    const fullIndex = isSplitLayout && topBarPanels
      ? subsetInsertIndex(merged.panelIds, topBarPanels.map(p => p.id), insertIndex)
      : insertIndex;
    const newRoot = movePanelInLayout(merged, panelId, { groupId: merged.id, index: fullIndex });
    applyLayout(sid, {
      ...currentLayout,
      root: newRoot,
      focusedGroupId: merged.id,
      zoomedGroupId: null,
    });
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, [primaryGroupId, primaryGroupNode, activeSession, isSplitLayout, topBarPanels, applyLayout]);

  // --- Editor stage element (shared by both layouts) ---
  const editorStageElement = useMemo(() => {
    if (!sessionLayout || !activeSession) return null;
    return (
      <SplitLayout
        layout={sessionLayout}
        panels={tabBarPanels}
        focusedGroupId={focusedGroupId}
        isMainRepo={!!activeSession.isMainRepo}
        onSizesChange={handleSizesChange}
        onPanelSelect={handleGroupPanelSelect}
        onPanelClose={handlePanelClose}
        onFocusGroup={handleFocusGroup}
        isTabDragging={isTabDragging}
        draggedPanelId={draggedPanelId}
        dropZones={dropZones}
        onDropZoneChange={handleDropZoneChange}
        onDropTab={handleDropTab}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onStripDrop={handleStripDrop}
        getPanelTabPresentation={getPanelTabPresentation}
      />
    );
  }, [
    sessionLayout, activeSession, tabBarPanels, focusedGroupId,
    handleSizesChange, handleGroupPanelSelect, handlePanelClose, handleFocusGroup,
    isTabDragging, draggedPanelId, dropZones, handleDropZoneChange,
    handleDropTab, handleDragStart, handleDragEnd, handleStripDrop, getPanelTabPresentation,
  ]);

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
    if (isRemoteMode) {
      useErrorStore.getState().showError({
        title: 'Open IDE unavailable',
        error: 'Open in IDE is only available in local mode. Switch this client back to the local runtime to use your desktop IDE.',
      });
      return;
    }
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
  }, [activeSession, isRemoteMode]);

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

  // Focused tool panels reserve the right/detail rail for the main workspace.
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

  // Layout-aware detail panel toggle that also handles immersive mode override
  const handleToggleDetailPanel = useCallback(() => {
    if (immersiveMode) {
      return;
    }
    if (layoutSwapped) {
      toggleDetailCollapse();
    } else {
      setDetailVisible(v => !v);
    }
  }, [immersiveMode, layoutSwapped, toggleDetailCollapse]);

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
    enabled: () => isInSessionView && !immersiveMode,
    action: handleToggleDetailPanel,
  });

  // Create branch actions for the panel bar
  const branchActions = useMemo(() => {
    if (!activeSession) return [];
    const busyReason = hook.isMerging
      ? 'Git operation already in progress'
      : activeSession.status === 'running' || activeSession.status === 'initializing'
        ? 'Session is currently running'
        : undefined;
    
    return activeSession.isMainRepo ? [
      {
        id: 'pull',
        label: 'Pull from Remote',
        icon: Download,
        onClick: hook.handleGitPull,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'default' as const,
        description: hook.gitCommands?.getPullCommand ? `git ${hook.gitCommands.getPullCommand()}` : 'git pull',
        disabledReason: busyReason,
      },
      {
        id: 'push',
        label: 'Push to Remote', 
        icon: Upload,
        onClick: hook.handleGitPush,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'success' as const,
        description: hook.gitCommands?.getPushCommand ? `git ${hook.gitCommands.getPushCommand()}` : 'git push',
        disabledReason: busyReason,
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
        description: `Fetch from remote into ${hook.gitCommands?.currentBranch || 'current branch'} without merging`,
        disabledReason: busyReason,
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
          : 'No changes to stash',
        disabledReason: busyReason ?? (activeSession.gitStatus?.hasUncommittedChanges ? undefined : 'No changes to stash'),
      },
      {
        id: 'stash-pop',
        label: 'Pop',
        icon: ArchiveRestore,
        onClick: hook.handleGitStashPop,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !hook.hasStash,
        variant: 'default' as const,
        description: hook.hasStash ? 'Apply and remove most recent stash' : 'No stash to pop',
        disabledReason: busyReason ?? (hook.hasStash ? undefined : 'No stash to pop'),
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
          : 'No changes to commit',
        disabledReason: busyReason ?? ((activeSession.gitStatus?.hasUncommittedChanges || activeSession.gitStatus?.hasUntrackedFiles) ? undefined : 'No changes to commit'),
      },
      {
        id: 'undo-commit',
        label: 'Undo Commit',
        icon: Undo2,
        shortcut: 'mod+alt+z',
        onClick: hook.handleGitSoftReset,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !activeSession.gitStatus?.ahead,
        variant: 'default' as const,
        description: activeSession.gitStatus?.ahead
          ? 'Undo last commit, keeping changes staged (git reset --soft HEAD~1)'
          : 'No commits to undo',
        disabledReason: busyReason ?? (activeSession.gitStatus?.ahead ? undefined : 'No commits to undo'),
      },
      {
        id: 'pull',
        label: 'Pull',
        icon: Download,
        shortcut: 'mod+shift+l',
        onClick: hook.handleGitPull,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'default' as const,
        description: `Pull latest changes into ${hook.gitCommands?.currentBranch || 'current branch'}`,
        disabledReason: busyReason,
      },
      {
        id: 'push',
        label: 'Push',
        icon: Upload,
        shortcut: 'mod+shift+u',
        onClick: hook.handleGitPush,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !activeSession.gitStatus?.ahead,
        variant: 'default' as const,
        description: activeSession.gitStatus?.ahead
          ? `Push ${activeSession.gitStatus.ahead} commit(s)${hook.gitCommands?.currentBranch ? ` from ${hook.gitCommands.currentBranch}` : ''} to remote`
          : 'No commits to push',
        disabledReason: busyReason ?? (activeSession.gitStatus?.ahead ? undefined : 'No commits to push'),
      },
      // --- Main branch operations (last) ---
      {
        id: 'rebase-from-main',
        label: 'Rebase',
        icon: GitPullRequestArrow,
        shortcut: 'mod+shift+r',
        onClick: hook.handleRebaseMainIntoWorktree,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !hook.hasChangesToRebase,
        variant: 'default' as const,
        description: hook.gitCommands?.getRebaseFromMainCommand ? hook.gitCommands.getRebaseFromMainCommand() : `Pulls latest changes from ${hook.gitCommands?.comparisonBaseBranch || 'main'}`,
        disabledReason: busyReason ?? (hook.hasChangesToRebase ? undefined : 'No changes to rebase from main'),
      },
      {
        id: 'rebase-to-main',
        label: 'Merge',
        icon: GitMerge,
        shortcut: 'mod+shift+m',
        onClick: hook.handleSquashAndRebaseToMain,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' ||
                  (!activeSession.gitStatus?.totalCommits || activeSession.gitStatus?.totalCommits === 0 || activeSession.gitStatus?.ahead === 0),
        variant: 'success' as const,
        description: (!activeSession.gitStatus?.totalCommits || activeSession.gitStatus?.totalCommits === 0 || activeSession.gitStatus?.ahead === 0) ?
                     'No commits to merge' :
                     (hook.gitCommands?.getSquashAndRebaseToMainCommand ? hook.gitCommands.getSquashAndRebaseToMainCommand() : `Merges all commits to ${hook.gitCommands?.comparisonBaseBranch || 'main'} (with safety checks)`),
        disabledReason: busyReason ?? ((!activeSession.gitStatus?.totalCommits || activeSession.gitStatus?.totalCommits === 0 || activeSession.gitStatus?.ahead === 0) ? 'No commits to merge' : undefined),
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

  if (activeView === 'pane-chat') {
    return <PaneChatView />;
  }

  if (!activeSession) {
    return <HomePage />;
  }
  
  return (
    <div className="pane-session-shell flex-1 flex flex-col overflow-hidden bg-bg-primary">
      {/* SINGLE SessionProvider wraps everything */}
      <SessionProvider session={activeSession} gitBranchActions={branchActions} isMerging={hook.isMerging} gitCommands={hook.gitCommands} onOpenIDEWithCommand={handleOpenIDEWithCommand} onConfigureIDE={() => setShowProjectSettings(true)} onSetTracking={handleOpenSetTracking} trackingBranch={currentUpstream} configuredIDECommand={sessionProject?.open_ide_command} isRemoteMode={isRemoteMode}>

        {/* Tab bar at top */}
        <PanelTabBar
          panels={tabBarPanels}
          activePanel={currentActivePanel}
          onPanelSelect={handlePanelSelect}
          onPanelClose={handlePanelClose}
          onPanelCreate={handlePanelCreate}
          onToggleDetailPanel={handleToggleDetailPanel}
          detailPanelVisible={detailVisible}
          detailPanelToggleDisabled={immersiveMode}
          detailPanelToggleDisabledReason="Hidden in Explorer and Diff views"
          primaryGroupPanels={topBarPanels}
          primaryGroupActivePanelId={isSplitLayout ? (currentActivePanel?.id ?? null) : primaryGroupNode?.activePanelId}
          primaryGroupFocused={!primaryGroupNode || primaryGroupNode.id === focusedGroupId}
          tabsInGroups={isSplitLayout}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onStripDrop={primaryGroupNode ? handlePrimaryStripDrop : undefined}
          isTabDragging={isTabDragging}
          draggedPanelId={draggedPanelId}
          getPanelTabPresentation={getPanelTabPresentation}
        />

        {/* Content area: center panels + right detail */}
        <div className="pane-session-content flex-1 flex flex-row min-h-0">
          {layoutSwapped && defaultTerminalPanel ? (
            <>
              {/* SWAPPED LAYOUT: Center column with panels on top, horizontal detail panel on bottom */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Top: active panel content */}
                <div className="pane-editor-stage flex-1 relative min-h-0 overflow-hidden bg-bg-editor">
                  {editorStageElement || (
                    <div className="flex-1 flex items-center justify-center text-text-secondary h-full">
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
                            initialCommand: 'codex --yolo',
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
                            {cmd.name.length > 13 ? cmd.name.slice(0, 13) + '…' : cmd.name}
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
                      isActive={!immersiveMode}
                      autoFocus={false}
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
                  {editorStageElement || (
                    <div className="flex-1 flex items-center justify-center text-text-secondary h-full">
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
                              initialCommand: 'codex --yolo',
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
                            <span
                              key={`shortcut-${index}`}
                              className="group/pill inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] font-medium text-text-tertiary border border-border-primary hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap flex-shrink-0 cursor-pointer"
                              onClick={() => handlePanelCreate('terminal', {
                                initialCommand: cmd.command,
                                title: cmd.name
                              })}
                              title={cmd.command}
                            >
                              {getCliBrandIcon(cmd.command, 'w-3 h-3') || <TerminalSquare className="w-3 h-3" />}
                              {cmd.name.length > 13 ? cmd.name.slice(0, 13) + '…' : cmd.name}
                              <button
                                className="p-0.5 rounded-full opacity-0 group-hover/pill:opacity-100 hover:bg-surface-tertiary hover:text-text-primary transition-all"
                                onClick={(e) => { e.stopPropagation(); deleteCustomCommand(index); }}
                                title="Remove shortcut"
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            </span>
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
                          autoFocus={false}
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
