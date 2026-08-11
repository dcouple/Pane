import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, CheckSquare, ChevronDown, ChevronRight, LayoutGrid, Loader2,
  RefreshCw, Settings2, Square,
} from 'lucide-react';
import { API } from '../../utils/api';
import { panelApi } from '../../services/panelApi';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { describeFleetTile, groupFleetTiles } from '../../utils/fleetGrouping';
import { AgentStatusDot } from '../ui/AgentStatusDot';
import { Button } from '../ui/Button';
import { Dropdown, type DropdownItem } from '../ui/Dropdown';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { FleetTile } from './FleetTile';
import type {
  FleetAgentPanel,
  FleetDensity,
  FleetGrouping,
  FleetSnapshot,
  FleetTileModel,
} from '../../../../shared/types/fleet';
import { MAX_FLEET_SNAPSHOT_PANELS } from '../../../../shared/types/fleet';

/** Snapshot cadence. Fast enough to feel live, slow enough to stay cheap. */
const POLL_INTERVAL_MS = 1500;
/** Debounce before a hovered tile is promoted to a real terminal. */
const PROMOTE_DELAY_MS = 250;

const GROUPING_OPTIONS: Array<{ value: FleetGrouping; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'status', label: 'Status' },
  { value: 'agent', label: 'Agent' },
  { value: 'none', label: 'None' },
];

const DENSITY_OPTIONS: FleetDensity[] = [1, 2, 3, 4];

/**
 * Above this many tiles, "all live" is refused: each live tile is a real xterm
 * instance with its own output subscription, and the DOM renderer's cost grows
 * linearly. Hover mode stays available at any count.
 */
const MAX_LIVE_ALL_TILES = 12;

/** Lower density = larger tiles, so more of each terminal is worth fetching. */
const LINES_BY_DENSITY: Record<FleetDensity, number> = { 1: 32, 2: 24, 3: 16, 4: 10 };

/**
 * View options that outlive a visit. Both answer "what does my fleet look
 * like", which is a property of the user's workflow rather than of this
 * session: whether answering an agent should enlarge its tile, and which
 * project groups are folded away because nothing there needs attention today.
 */
const EXPAND_ON_FOCUS_KEY = 'pane.fleet.expandOnFocus';
const COLLAPSED_GROUPS_KEY = 'pane.fleet.collapsedGroups';
const SEND_ESCAPE_KEY = 'pane.fleet.sendEscape';
const GROUPING_KEY = 'pane.fleet.grouping';
const DENSITY_KEY = 'pane.fleet.density';

function readStoredOption<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Corrupt or unavailable storage must never keep the view from rendering.
    return fallback;
  }
}

function writeStoredOption(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or a locked-down profile — the option just stays session-only.
  }
}

/**
 * Live grid of every agent pane across every session and project.
 *
 * Tiles poll a batched, ANSI-stripped snapshot while this view is visible, and
 * exactly one tile at a time is promoted to a real read-only terminal on hover
 * or focus. That cap is deliberate: xterm instances sharing a font and theme
 * share a WebGL texture atlas, and a grid of live terminals would exhaust
 * Chromium's GL contexts (see `TerminalPanel`'s header comment).
 */
export function FleetView() {
  const [agents, setAgents] = useState<FleetAgentPanel[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, FleetSnapshot>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<FleetGrouping>(
    () => readStoredOption<FleetGrouping>(GROUPING_KEY, 'project')
  );
  const [density, setDensity] = useState<FleetDensity>(
    () => readStoredOption<FleetDensity>(DENSITY_KEY, 3)
  );
  const [liveTileId, setLiveTileId] = useState<string | null>(null);
  const [liveAll, setLiveAll] = useState(false);
  /** Panel currently open in the full-size interactive view, if any. */
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  /** The grid's roving keyboard cursor — selection, not focus. */
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  /** Tile awaiting a close confirmation. */
  const [pendingClose, setPendingClose] = useState<FleetTileModel | null>(null);
  const [closing, setClosing] = useState(false);
  /**
   * Whether answering an agent enlarges its tile. Off, the tile keeps its size
   * and simply takes the keyboard — better when the grid layout itself is the
   * thing being watched.
   */
  const [expandOnFocus, setExpandOnFocus] = useState<boolean>(
    () => readStoredOption(EXPAND_ON_FOCUS_KEY, true)
  );
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<string[]>(
    () => readStoredOption<string[]>(COLLAPSED_GROUPS_KEY, [])
  );
  /**
   * Whether Escape reaches the agent. Off, it leaves typing mode instead —
   * the usual intent in a grid, and unlike an interrupt it can be undone by
   * clicking the tile again.
   */
  const [sendEscape, setSendEscape] = useState<boolean>(
    () => readStoredOption(SEND_ESCAPE_KEY, false)
  );

  const promoteTimerRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef(false);
  /** Display order captured when a tile took the keyboard; see handleFocusAgent. */
  const frozenOrderRef = useRef<{ groups: string[]; tiles: string[] } | null>(null);
  /** Tile elements, so keyboard navigation can scroll a selection into view. */
  const tileElementsRef = useRef(new Map<string, HTMLElement>());

  const agentStatus = usePanelStore(state => state.agentStatus);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const setActivePanelInStore = usePanelStore(state => state.setActivePanel);
  const activeView = useNavigationStore(state => state.activeView);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);

  const snapshotLines = LINES_BY_DENSITY[density];

  const loadAgents = useCallback(async () => {
    try {
      const response = await API.fleet.listAgents();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to list agents');
      }
      setAgents(response.data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to list agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Agents appearing or disappearing shows up as agent-status churn; refresh
  // the roster on it rather than polling the (heavier) list endpoint.
  const agentStatusKeys = Object.keys(agentStatus).sort().join(',');
  useEffect(() => {
    void loadAgents();
  }, [agentStatusKeys, loadAgents]);

  const canLiveAll = agents.length <= MAX_LIVE_ALL_TILES;
  const liveAllActive = liveAll && canLiveAll;

  const tiles: FleetTileModel[] = useMemo(
    () => agents.map(agent => ({
      ...agent,
      agentState: agentStatus[agent.panelId] ?? 'unknown',
      snapshot: snapshots[agent.panelId] ?? null,
    })),
    [agents, agentStatus, snapshots]
  );

  const groups = useMemo(() => groupFleetTiles(tiles, grouping), [tiles, grouping]);

  const collapsedGroups = useMemo(() => new Set(collapsedGroupKeys), [collapsedGroupKeys]);

  /**
   * `groups` in the order the user last saw them while typing.
   *
   * Content still updates — only the running order is pinned, and anything new
   * lands at the end rather than shuffling what is already on screen.
   */
  const displayedGroups = useMemo(() => {
    const frozen = focusedPanelId ? frozenOrderRef.current : null;
    if (!frozen) return groups;

    const rankOf = (order: string[], key: string) => {
      const index = order.indexOf(key);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };

    return [...groups]
      .sort((a, b) => rankOf(frozen.groups, a.key) - rankOf(frozen.groups, b.key))
      .map(group => ({
        ...group,
        tiles: [...group.tiles].sort(
          (a, b) => rankOf(frozen.tiles, a.panelId) - rankOf(frozen.tiles, b.panelId)
        ),
      }));
  }, [groups, focusedPanelId]);

  useEffect(() => writeStoredOption(EXPAND_ON_FOCUS_KEY, expandOnFocus), [expandOnFocus]);
  useEffect(() => writeStoredOption(COLLAPSED_GROUPS_KEY, collapsedGroupKeys), [collapsedGroupKeys]);
  useEffect(() => writeStoredOption(SEND_ESCAPE_KEY, sendEscape), [sendEscape]);
  useEffect(() => writeStoredOption(GROUPING_KEY, grouping), [grouping]);
  useEffect(() => writeStoredOption(DENSITY_KEY, density), [density]);

  // A folded-away group costs nothing: its panels leave the snapshot batch, so
  // the emulators behind them are never woken for a tile nobody can see.
  const panelIds = useMemo(
    () => groups
      .filter(group => !collapsedGroups.has(group.key))
      .flatMap(group => group.tiles.map(tile => tile.panelId))
      .slice(0, MAX_FLEET_SNAPSHOT_PANELS),
    [groups, collapsedGroups]
  );
  const panelIdsKey = panelIds.join(',');

  // Poll snapshots only while this view is actually on screen. A background
  // poll would keep every agent's emulator warm for nothing.
  useEffect(() => {
    if (activeView !== 'fleet' || panelIds.length === 0) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled || inFlightRef.current) return;
      if (document.visibilityState !== 'visible') return;
      inFlightRef.current = true;
      try {
        const response = await API.fleet.snapshots({ panelIds, maxLines: snapshotLines });
        if (cancelled || !response.success || !response.data) return;
        const next: Record<string, FleetSnapshot> = {};
        for (const snapshot of response.data.snapshots) next[snapshot.panelId] = snapshot;
        setSnapshots(next);
      } catch {
        // A dropped poll is not worth surfacing; the next tick retries.
      } finally {
        inFlightRef.current = false;
      }
    };

    void tick();
    // With every tile live, snapshots only still matter for stopped panels and
    // for PTY dimension changes, so the poll can back right off.
    const timer = window.setInterval(() => { void tick(); }, liveAllActive ? POLL_INTERVAL_MS * 6 : POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // panelIdsKey stands in for panelIds so a re-render with the same ids does
    // not restart the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, panelIdsKey, snapshotLines, liveAllActive]);

  const statusSummary = useMemo(() => ({
    blocked: tiles.filter(tile => tile.agentState === 'blocked').length,
    working: tiles.filter(tile => tile.agentState === 'working').length,
  }), [tiles]);

  // In "all live" mode hover is irrelevant — every tile is already live.
  const handleHoverStart = useCallback((panelId: string) => {
    if (liveAll) return;
    // The focused tile is already live and owns the keyboard.
    if (focusedPanelId === panelId) return;
    window.clearTimeout(promoteTimerRef.current);
    promoteTimerRef.current = window.setTimeout(() => setLiveTileId(panelId), PROMOTE_DELAY_MS);
  }, [liveAll, focusedPanelId]);

  const handleHoverEnd = useCallback((panelId: string) => {
    if (liveAll) return;
    // The focused tile keeps the keyboard even when the pointer leaves it.
    if (focusedPanelId === panelId) return;
    window.clearTimeout(promoteTimerRef.current);
    setLiveTileId(current => (current === panelId ? null : current));
  }, [liveAll, focusedPanelId]);

  useEffect(() => () => window.clearTimeout(promoteTimerRef.current), []);

  const handleFocusAgent = useCallback((tile: FleetTileModel) => {
    window.clearTimeout(promoteTimerRef.current);
    // Tiles are ordered by urgency, so answering an agent changes its state and
    // re-sorts the grid underneath the pointer — the tile the user is typing
    // into jumps to another column and back. Pin the running order for as long
    // as someone is typing.
    frozenOrderRef.current = {
      groups: groups.map(group => group.key),
      tiles: groups.flatMap(group => group.tiles.map(member => member.panelId)),
    };
    setFocusedPanelId(tile.panelId);
    // Keep it live regardless of where the pointer goes: demoting to a
    // snapshot mid-typing would drop the keyboard.
    setLiveTileId(tile.panelId);
  }, [groups]);

  const handleCloseFocus = useCallback(() => {
    frozenOrderRef.current = null;
    setFocusedPanelId(null);
  }, []);

  /**
   * Fold a group away, or bring it back.
   *
   * Hiding the group that holds the focused tile also releases the keyboard:
   * an agent nobody can see must not keep receiving what the user types.
   */
  const handleToggleGroup = useCallback((groupKey: string) => {
    const group = groups.find(candidate => candidate.key === groupKey);
    const isCollapsing = !collapsedGroups.has(groupKey);

    if (isCollapsing && group?.tiles.some(tile => tile.panelId === focusedPanelId)) {
      setFocusedPanelId(null);
      setLiveTileId(null);
    }

    setCollapsedGroupKeys(current => (
      current.includes(groupKey)
        ? current.filter(key => key !== groupKey)
        : [...current, groupKey]
    ));
  }, [groups, collapsedGroups, focusedPanelId]);

  // Track the live tile model so the focus view keeps seeing fresh snapshots
  // (dimensions, status) as polls arrive.
  const focusedTile = useMemo(
    () => tiles.find(tile => tile.panelId === focusedPanelId) ?? null,
    [tiles, focusedPanelId]
  );

  // A panel that disappears (session archived, agent stopped) must not leave a
  // dialog attached to nothing.
  useEffect(() => {
    if (focusedPanelId && !focusedTile) setFocusedPanelId(null);
  }, [focusedPanelId, focusedTile]);

  // Drop the hover promotion when switching into all-live so the two modes
  // never both own a terminal for the same panel.
  useEffect(() => {
    if (liveAllActive) setLiveTileId(null);
  }, [liveAllActive]);

  /**
   * Open the agent this tile represents.
   *
   * The active panel is persisted *before* navigating: `SessionView` reloads a
   * session's panels on activation and takes the active panel from the
   * backend, which would otherwise immediately overwrite a client-only
   * selection and land the user on whatever panel was last open.
   */
  const handleOpen = useCallback(async (tile: FleetTileModel) => {
    setLiveTileId(null);
    try {
      await panelApi.setActivePanel(tile.sessionId, tile.panelId);
    } catch {
      // Fall through: the session still opens, just on its stored panel.
    }
    setActivePanelInStore(tile.sessionId, tile.panelId);
    await setActiveSession(tile.sessionId);
    navigateToSessions();
  }, [setActiveSession, setActivePanelInStore, navigateToSessions]);

  // --- Keyboard navigation ---

  /** Every tile on screen, in reading order, ignoring folded groups. */
  const visibleTiles = useMemo(
    () => displayedGroups
      .filter(group => grouping === 'none' || !collapsedGroups.has(group.key))
      .flatMap(group => group.tiles),
    [displayedGroups, grouping, collapsedGroups]
  );

  const registerTileElement = useCallback((panelId: string, element: HTMLElement | null) => {
    if (element) tileElementsRef.current.set(panelId, element);
    else tileElementsRef.current.delete(panelId);
  }, []);

  const revealTile = useCallback((panelId: string) => {
    tileElementsRef.current.get(panelId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const selectTile = useCallback((panelId: string) => {
    setSelectedPanelId(panelId);
    revealTile(panelId);
  }, [revealTile]);

  /**
   * Take the user to the next agent that is waiting on them.
   *
   * The whole point of the fleet is answering agents; without this, finding the
   * one that is blocked means scanning a wall of tiles for a red dot.
   */
  const jumpToNextBlocked = useCallback(() => {
    const blocked = visibleTiles.filter(tile => tile.agentState === 'blocked');
    if (blocked.length === 0) return;

    const anchor = focusedPanelId ?? selectedPanelId;
    const currentIndex = blocked.findIndex(tile => tile.panelId === anchor);
    const next = blocked[(currentIndex + 1) % blocked.length];

    selectTile(next.panelId);
    if (next.isLive) handleFocusAgent(next);
  }, [visibleTiles, focusedPanelId, selectedPanelId, selectTile, handleFocusAgent]);

  /**
   * Arrows move a selection across the grid, Enter hands it the keyboard.
   *
   * Bound on the document rather than the grid so it works without clicking
   * first, and disabled the moment a tile is focused — those keys belong to the
   * agent then, and Escape is already spoken for.
   */
  useEffect(() => {
    if (activeView !== 'fleet') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (focusedPanelId || pendingClose) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;
      if (visibleTiles.length === 0) return;

      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        jumpToNextBlocked();
        return;
      }

      const index = visibleTiles.findIndex(tile => tile.panelId === selectedPanelId);
      const step = ({
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: density,
        ArrowUp: -density,
      } as Record<string, number | undefined>)[event.key];

      if (step !== undefined) {
        event.preventDefault();
        // Nothing selected yet: the first arrow lands on the first tile.
        const nextIndex = index === -1
          ? 0
          : Math.min(Math.max(index + step, 0), visibleTiles.length - 1);
        selectTile(visibleTiles[nextIndex].panelId);
        return;
      }

      if (event.key === 'Enter' && index !== -1) {
        const tile = visibleTiles[index];
        if (!tile.isLive) return;
        event.preventDefault();
        handleFocusAgent(tile);
        return;
      }

      if (event.key === 'Escape' && selectedPanelId) {
        event.preventDefault();
        setSelectedPanelId(null);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    activeView, focusedPanelId, pendingClose, visibleTiles, selectedPanelId,
    density, selectTile, handleFocusAgent, jumpToNextBlocked,
  ]);

  const viewOptionItems: DropdownItem[] = useMemo(() => [
    {
      id: 'expand-on-click',
      label: 'Expand on click',
      description: expandOnFocus
        ? 'Clicking an agent enlarges its tile to the agent’s full screen'
        : 'Tiles keep their size and simply take the keyboard',
      icon: expandOnFocus ? CheckSquare : Square,
      onClick: () => setExpandOnFocus(current => !current),
    },
    {
      id: 'send-escape',
      label: 'Send Escape',
      description: sendEscape
        ? 'Escape reaches the agent, as in its own terminal'
        : 'Escape leaves typing mode and gives the keyboard back',
      icon: sendEscape ? CheckSquare : Square,
      onClick: () => setSendEscape(current => !current),
    },
    {
      id: 'all-live',
      label: 'All live',
      description: canLiveAll
        ? 'Render every agent as a live terminal instead of on hover'
        : `Only available with ${MAX_LIVE_ALL_TILES} agents or fewer`,
      icon: liveAllActive ? CheckSquare : Square,
      disabled: !canLiveAll,
      onClick: () => setLiveAll(current => !current),
    },
  ], [expandOnFocus, sendEscape, liveAllActive, canLiveAll]);

  // --- Closing a pane ---

  const handleConfirmClose = useCallback(async () => {
    const tile = pendingClose;
    if (!tile) return;

    setClosing(true);
    try {
      await panelApi.deletePanel(tile.panelId);
      if (focusedPanelId === tile.panelId) handleCloseFocus();
      setLiveTileId(current => (current === tile.panelId ? null : current));
      setSelectedPanelId(current => (current === tile.panelId ? null : current));
      setPendingClose(null);
      await loadAgents();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to close the pane');
      setPendingClose(null);
    } finally {
      setClosing(false);
    }
  }, [pendingClose, focusedPanelId, handleCloseFocus, loadAgents]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
          <h1 className="text-sm font-medium text-text-primary">Agent fleet</h1>
          <span className="text-[11px] text-text-tertiary">
            {tiles.length} {tiles.length === 1 ? 'agent' : 'agents'}
          </span>

          {/*
            At-a-glance roll-up, and the fastest way to act on it: the blocked
            count is the button that takes you to the next waiting agent.
          */}
          {statusSummary.blocked > 0 && (
            <button
              type="button"
              onClick={jumpToNextBlocked}
              title="Go to the next agent waiting for you (N)"
              className="flex items-center gap-1 rounded-full bg-status-error/15 px-2 py-px text-[10px] font-medium text-status-error transition-colors hover:bg-status-error/25 focus:outline-none focus-visible:ring-1 focus-visible:ring-status-error"
            >
              <AgentStatusDot status="blocked" size="sm" />
              {statusSummary.blocked} need input
              <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
          )}
          {statusSummary.working > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-interactive/15 px-2 py-px text-[10px] font-medium text-interactive">
              <AgentStatusDot status="working" size="sm" />
              {statusSummary.working} working
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-4">
          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">Group agents by</legend>
            <span className="text-[10px] uppercase tracking-wider text-text-muted">Group</span>
            {GROUPING_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={grouping === option.value}
                onClick={() => setGrouping(option.value)}
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  grouping === option.value
                    ? 'bg-interactive text-text-on-interactive'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                {option.label}
              </button>
            ))}
          </fieldset>

          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">Tiles per row</legend>
            <span className="text-[10px] uppercase tracking-wider text-text-muted">Columns</span>
            {DENSITY_OPTIONS.map(option => (
              <button
                key={option}
                type="button"
                aria-pressed={density === option}
                aria-label={`${option} tiles per row`}
                onClick={() => setDensity(option)}
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  density === option
                    ? 'bg-interactive text-text-on-interactive'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                {option}×
              </button>
            ))}
          </fieldset>

          {/*
            Group and Columns are changed constantly and stay on the bar; these
            three are set once and would otherwise crowd it out.
          */}
          <Dropdown
            position="bottom-right"
            width="lg"
            closeOnSelect={false}
            items={viewOptionItems}
            trigger={
              <button
                type="button"
                aria-label="View options"
                title="View options"
                className="rounded p-1 transition-colors hover:bg-surface-hover"
              >
                <Settings2 className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
              </button>
            }
          />

          <button
            type="button"
            onClick={() => { void loadAgents(); }}
            aria-label="Refresh agent list"
            className="rounded p-1 transition-colors hover:bg-surface-hover"
          >
            <RefreshCw className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Finding agents…
          </div>
        ) : error ? (
          <div className="rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">
            {error}
          </div>
        ) : tiles.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-secondary">
            No agent panes yet. Start Claude or Codex in a session and it will appear here.
          </div>
        ) : (
          displayedGroups.map(group => {
            // Grouping "none" is one unlabelled bucket: no header, nothing to
            // fold it into.
            const isCollapsible = grouping !== 'none';
            const isCollapsed = isCollapsible && collapsedGroups.has(group.key);
            const blockedInGroup = group.tiles.filter(tile => tile.agentState === 'blocked').length;
            const workingInGroup = group.tiles.filter(tile => tile.agentState === 'working').length;

            return (
              <section key={group.key} className="mb-5 last:mb-0">
                {isCollapsible && (
                  <h2 className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                    <button
                      type="button"
                      onClick={() => handleToggleGroup(group.key)}
                      aria-expanded={!isCollapsed}
                      title={isCollapsed ? `Show ${group.label}` : `Hide ${group.label}`}
                      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-surface-hover hover:text-text-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-interactive"
                    >
                      {isCollapsed
                        ? <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                        : <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />}
                      <span className="truncate">{group.label}</span>
                      <span className="rounded-full bg-surface-tertiary px-1.5 text-[10px] tabular-nums text-text-muted">
                        {group.tiles.length}
                      </span>
                    </button>
                    {/*
                      Counts rather than a bare total, so a folded group says
                      exactly as much as an open one.
                    */}
                    {blockedInGroup > 0 && (
                      <span className="flex items-center gap-1 rounded-full bg-status-error/15 px-2 py-px text-[10px] normal-case tracking-normal text-status-error">
                        <AgentStatusDot status="blocked" size="sm" />
                        {blockedInGroup} waiting
                      </span>
                    )}
                    {workingInGroup > 0 && (
                      <span className="flex items-center gap-1 rounded-full bg-interactive/15 px-2 py-px text-[10px] normal-case tracking-normal text-interactive">
                        <AgentStatusDot status="working" size="sm" />
                        {workingInGroup} working
                      </span>
                    )}
                    <span className="h-px flex-1 bg-border-primary" aria-hidden="true" />
                  </h2>
                )}
                {!isCollapsed && (
                  <div
                    className="grid items-start gap-2.5"
                    style={{ gridTemplateColumns: `repeat(${density}, minmax(0, 1fr))` }}
                  >
                    {group.tiles.map(tile => (
                      <FleetTile
                        key={tile.panelId}
                        tile={tile}
                        // The focused tile stays live no matter where the pointer
                        // goes: hovering a neighbour used to demote it back to a
                        // snapshot mid-typing, taking the keyboard with it.
                        isLiveView={liveAllActive || liveTileId === tile.panelId || focusedPanelId === tile.panelId}
                        onHoverStart={handleHoverStart}
                        onHoverEnd={handleHoverEnd}
                        onOpen={(target) => { void handleOpen(target); }}
                        snapshotLines={snapshotLines}
                        isFocused={focusedPanelId === tile.panelId}
                        expandWhenFocused={expandOnFocus}
                        sendEscape={sendEscape}
                        isSelected={selectedPanelId === tile.panelId}
                        registerElement={registerTileElement}
                        onFocusAgent={handleFocusAgent}
                        onCollapse={handleCloseFocus}
                        onClose={setPendingClose}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}

        {agents.length > MAX_FLEET_SNAPSHOT_PANELS && (
          <p className="pt-2 text-[11px] text-text-muted">
            Live previews are limited to the first {MAX_FLEET_SNAPSHOT_PANELS} agents.
          </p>
        )}
      </div>

      {/*
        Closing kills the agent's process and drops its scrollback, and a stray
        click on a small icon must not be able to do that silently.
      */}
      <Modal
        isOpen={pendingClose !== null}
        onClose={() => setPendingClose(null)}
        size="sm"
        ariaLabel="Close pane"
        showCloseButton={false}
      >
        <ModalHeader
          title="Close this pane?"
          description={pendingClose ? describeFleetTile(pendingClose) : undefined}
        />
        <ModalBody>
          <p className="text-sm text-text-secondary">
            The agent process is stopped and this pane’s terminal history is deleted.
            The session and its worktree stay untouched.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="sm" onClick={() => setPendingClose(null)} disabled={closing}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => { void handleConfirmClose(); }}
            disabled={closing}
          >
            {closing ? 'Closing…' : 'Close pane'}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}

export default FleetView;
