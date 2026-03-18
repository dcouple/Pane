import React, { useCallback, memo, useState, useRef, useEffect, useMemo } from 'react';
import { Plus, X, Terminal, ChevronDown, ChevronRight, GitBranch, FileCode, BarChart3, PanelRight, FolderTree, TerminalSquare, Play, Cpu, RefreshCw } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';
import { useHotkey } from '../../hooks/useHotkey';
import { PanelTabBarProps, PanelCreateOptions } from '../../types/panelComponents';
import { ToolPanel, ToolPanelType, PANEL_CAPABILITIES, LogsPanelState } from '../../../../shared/types/panels';
import { useSession } from '../../contexts/SessionContext';
import { StatusIndicator } from '../StatusIndicator';
import { useConfigStore } from '../../stores/configStore';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { useHotkeyStore } from '../../stores/hotkeyStore';
import { Tooltip } from '../ui/Tooltip';
import { Kbd } from '../ui/Kbd';
import { useResourceMonitor } from '../../hooks/useResourceMonitor';
import { ClaudeIcon, OpenAIIcon, CLI_BRAND_ICONS, getCliBrandIcon } from '../ui/BrandIcons';

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(mb * 1024)} KB`;
}

// Prompt for setting up intelligent dev command
export const SETUP_RUN_SCRIPT_PROMPT = `I use Pane to manage multiple AI coding sessions with git worktrees.
Each worktree needs its own dev server on a unique port.

Create scripts/pane-run-script.js (Node.js, cross-platform) that:
1. Auto-detects git worktrees vs main repo
2. Assigns unique ports using hash(cwd) % 1000 + base_port, with separate ranges for main vs worktrees
3. Auto-detects if deps need installing (package.json mtime > node_modules mtime)
4. Auto-detects if build is stale (src mtime > dist mtime)
5. Clean Ctrl+C termination (taskkill on Windows, SIGTERM on Unix)
6. Auto-detects project type (package.json, requirements.txt, Cargo.toml, go.mod, etc.)
7. Prints the URL/port being used so user knows where to access the app

CRITICAL EDGE CASES — these cause the most bugs:
- Port availability checks MUST test BOTH 0.0.0.0 AND :: (IPv6) — dev servers often bind to :: (all interfaces), so a check on 127.0.0.1 alone passes but the server fails with EADDRINUSE
- Before auto-incrementing to a new port, try to RECLAIM the preferred port by finding the PID holding it (lsof/netstat), verifying it belongs to this project's dev server (match the command line against the project directory or dev server binary), and only then killing it — never kill unrelated processes
- Clean up stale framework lock files before starting (.next/dev/lock, .cache/lock, .vite/ temp files, etc.) — these are left by crashed/killed sessions and prevent restart
- Cross-platform process management (taskkill /F /T on Windows, kill process group on Unix)

Analyze this project's actual framework and structure first, then create the complete pane-run-script.js tailored to it.

IMPORTANT: After creating the script, TEST THE RESTART PATH — run 'node scripts/pane-run-script.js', then kill it ungracefully (Ctrl+C or kill the terminal), then run it again. It must reclaim the same port without EADDRINUSE or lock file errors. A single happy-path run proves nothing. Then commit and merge to main so all future worktrees have it.`;

export const PanelTabBar: React.FC<PanelTabBarProps> = memo(({
  panels,
  activePanel,
  onPanelSelect,
  onPanelClose,
  onPanelCreate,
  context = 'worktree',  // Default to worktree for backward compatibility
  onToggleDetailPanel,
  detailPanelVisible
}) => {
  const sessionContext = useSession();
  const session = sessionContext?.session;
  const { config, fetchConfig, updateConfig } = useConfigStore();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownMenuRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customCommand, setCustomCommand] = useState('');
  const customInputRef = useRef<HTMLInputElement>(null);
  const [, setFocusedDropdownIndex] = useState(-1);
  const dropdownItemsRef = useRef<(HTMLButtonElement | HTMLInputElement | null)[]>([]);

  // Resource monitor state
  const [showResourcePopover, setShowResourcePopover] = useState(false);
  const resourceChipRef = useRef<HTMLButtonElement>(null);
  const resourcePopoverRef = useRef<HTMLDivElement>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['pane-app']));
  const { snapshot, startActive, stopActive, refresh } = useResourceMonitor();
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  const customCommands = config?.customCommands ?? [];
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = useCallback((id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  }, [hotkeys]);

  // Load config on mount if not already loaded
  useEffect(() => {
    if (!config) {
      fetchConfig();
    }
  }, [config, fetchConfig]);

  const saveCustomCommand = useCallback(async (name: string, command: string) => {
    const existing = config?.customCommands ?? [];
    await updateConfig({
      customCommands: [...existing, { name, command }]
    }).catch(() => {});
  }, [config, updateConfig]);

  const deleteCustomCommand = useCallback(async (index: number) => {
    const existing = config?.customCommands ?? [];
    await updateConfig({
      customCommands: existing.filter((_, i) => i !== index)
    }).catch(() => {});
  }, [config, updateConfig]);
  
  // Resource monitor handlers
  const toggleResourcePopover = useCallback(() => {
    setShowResourcePopover(prev => {
      if (!prev) startActive();
      else stopActive();
      return !prev;
    });
  }, [startActive, stopActive]);

  // Popover positioning
  useEffect(() => {
    if (showResourcePopover && resourceChipRef.current) {
      const rect = resourceChipRef.current.getBoundingClientRect();
      setPopoverStyle({
        position: 'fixed',
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
        zIndex: 10000,
      });
    }
  }, [showResourcePopover]);

  // Click-outside handler for resource popover
  useEffect(() => {
    if (!showResourcePopover) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        resourceChipRef.current && !resourceChipRef.current.contains(target) &&
        resourcePopoverRef.current && !resourcePopoverRef.current.contains(target)
      ) {
        setShowResourcePopover(false);
        stopActive();
      }
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handleClickOutside); };
  }, [showResourcePopover, stopActive]);

  // Add Tool dropdown positioning
  useEffect(() => {
    if (!showDropdown || !dropdownRef.current) return;
    const updatePosition = () => {
      if (!dropdownRef.current) return;
      const rect = dropdownRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        zIndex: 10000,
        minWidth: 280,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [showDropdown]);

  // Escape handler for resource popover
  useEffect(() => {
    if (!showResourcePopover) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowResourcePopover(false); stopActive(); }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showResourcePopover, stopActive]);

  const toggleSection = useCallback((id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleRefresh = useCallback(() => { refresh(); }, [refresh]);

  const electronTotalCpu = useMemo(() =>
    snapshot?.electronProcesses.reduce((sum, p) => sum + p.cpuPercent, 0) ?? 0
  , [snapshot]);

  const electronTotalMem = useMemo(() =>
    snapshot?.electronProcesses.reduce((sum, p) => sum + p.memoryMB, 0) ?? 0
  , [snapshot]);

  // Memoize event handlers to prevent unnecessary re-renders
  const handlePanelClick = useCallback((panel: ToolPanel) => {
    onPanelSelect(panel);
  }, [onPanelSelect]);

  const handlePanelClose = useCallback((e: React.MouseEvent, panel: ToolPanel) => {
    e.stopPropagation();
    
    // Prevent closing logs panel while it's running
    if (panel.type === 'logs') {
      const logsState = panel.state?.customState as LogsPanelState;
      if (logsState?.isRunning) {
        alert('Cannot close logs panel while process is running. Please stop the process first.');
        return;
      }
    }
    
    onPanelClose(panel);
  }, [onPanelClose]);
  
  const handleAddPanel = useCallback((type: ToolPanelType, options?: PanelCreateOptions) => {
    onPanelCreate(type, options);
    setShowDropdown(false);
    setShowCustomInput(false);
    setCustomCommand('');
  }, [onPanelCreate]);
  
  const handleStartRename = useCallback((e: React.MouseEvent, panel: ToolPanel) => {
    e.stopPropagation();
    if (panel.type === 'diff') {
      return;
    }
    setEditingPanelId(panel.id);
    setEditingTitle(panel.title);
  }, []);
  
  const handleRenameSubmit = useCallback(async () => {
    if (editingPanelId && editingTitle.trim()) {
      try {
        // Update the panel title via IPC
        await window.electron?.invoke('panels:update', editingPanelId, {
          title: editingTitle.trim()
        });
        
        // Update the local panel in the store
        const panel = panels.find(p => p.id === editingPanelId);
        if (panel) {
          panel.title = editingTitle.trim();
        }
      } catch (error) {
        console.error('Failed to rename panel:', error);
      }
    }
    setEditingPanelId(null);
    setEditingTitle('');
  }, [editingPanelId, editingTitle, panels]);
  
  const handleRenameCancel = useCallback(() => {
    setEditingPanelId(null);
    setEditingTitle('');
  }, []);
  
  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      handleRenameCancel();
    }
  }, [handleRenameSubmit, handleRenameCancel]);
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        event.target &&
        event.target instanceof Node &&
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target) &&
        dropdownMenuRef.current &&
        !dropdownMenuRef.current.contains(event.target)
      ) {
        setShowDropdown(false);
        setShowCustomInput(false);
        setCustomCommand('');
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDropdown]);

  // Auto-focus custom command input when shown
  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus();
    }
  }, [showCustomInput]);

  // Reset focus index when dropdown closes, focus first item when opens
  useEffect(() => {
    if (showDropdown) {
      setFocusedDropdownIndex(0);
      // Focus first item after render
      requestAnimationFrame(() => {
        dropdownItemsRef.current[0]?.focus();
      });
    } else {
      setFocusedDropdownIndex(-1);
      dropdownItemsRef.current = [];
    }
  }, [showDropdown]);

  // Handle keyboard navigation in dropdown
  const handleDropdownKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = dropdownItemsRef.current.filter(Boolean);
    const itemCount = items.length;

    if (itemCount === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedDropdownIndex(prev => {
          const next = prev < itemCount - 1 ? prev + 1 : 0;
          items[next]?.focus();
          return next;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedDropdownIndex(prev => {
          const next = prev > 0 ? prev - 1 : itemCount - 1;
          items[next]?.focus();
          return next;
        });
        break;
      case 'Escape':
        e.preventDefault();
        setShowDropdown(false);
        break;
      case 'Tab':
        // Allow tab to close dropdown and move to next element
        setShowDropdown(false);
        break;
    }
  }, []);
  
  // Focus input when editing starts
  useEffect(() => {
    if (editingPanelId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingPanelId]);
  
  // Ctrl+T: open Add Tool dropdown
  useHotkey({
    id: 'open-add-tool',
    label: 'Open Add Tool menu',
    keys: 'mod+t',
    category: 'tabs',
    action: () => setShowDropdown(true),
  });

  // Get available panel types (excluding permanent panels, logs, and enforcing singleton)
  const availablePanelTypes = (Object.keys(PANEL_CAPABILITIES) as ToolPanelType[])
    .filter(type => {
      const capabilities = PANEL_CAPABILITIES[type];

      // Filter based on context
      if (context === 'project' && !capabilities.canAppearInProjects) return false;
      if (context === 'worktree' && !capabilities.canAppearInWorktrees) return false;

      // Exclude permanent panels
      if (capabilities.permanent) return false;

      // Exclude logs panel - it's only created automatically when running scripts
      if (type === 'logs') return false;

      // Enforce singleton panels
      if (capabilities.singleton) {
        // Check if a panel of this type already exists
        return !panels.some(p => p.type === type);
      }

      return true;
    });
  
  const getPanelIcon = (type: ToolPanelType, panel?: ToolPanel) => {
    // Check for brand-specific terminal panels by title
    if (type === 'terminal' && panel) {
      const title = panel.title.toLowerCase();
      for (const [keyword, IconComponent] of Object.entries(CLI_BRAND_ICONS)) {
        if (title.includes(keyword)) {
          return <IconComponent className="w-4 h-4" />;
        }
      }
    }
    switch (type) {
      case 'terminal':
        return <Terminal className="w-4 h-4" />;
      case 'diff':
        return <GitBranch className="w-4 h-4" />;
      case 'explorer':
        return <FolderTree className="w-4 h-4" />;
      case 'logs':
        return <FileCode className="w-4 h-4" />;
      case 'dashboard':
        return <BarChart3 className="w-4 h-4" />;
      default:
        return null;
    }
  };

  // Sort panels: diff first, explorer second, then by position
  const sortedPanels = useMemo(() => {
    const typeOrder = (type: string) => {
      if (type === 'diff') return 0;
      if (type === 'explorer') return 1;
      return 2;
    };
    return [...panels].sort((a, b) => {
      const orderDiff = typeOrder(a.type) - typeOrder(b.type);
      if (orderDiff !== 0) return orderDiff;
      return (a.metadata?.position ?? 0) - (b.metadata?.position ?? 0);
    });
  }, [panels]);

  return (
    <>
    <div className="panel-tab-bar bg-bg-chrome flex-shrink-0">
      {/* Flex container */}
      <div
        className="flex items-center min-h-[var(--panel-tab-height)] px-2 gap-x-1"
        role="tablist"
        aria-label="Panel Tabs"
      >
        {/* Session identity */}
        {session && (
          <div className="flex items-center gap-2 px-2 mr-1 flex-shrink-0 border-r border-border-primary">
            <StatusIndicator session={session} size="small" />
            <span className="text-sm text-text-secondary truncate min-w-0 select-none" style={{ maxWidth: '140px' }}>
              {sessionContext?.projectName || session.name}
            </span>
          </div>
        )}

        {/* Scrollable tab area */}
        <div className="flex items-center gap-x-1 overflow-x-auto scrollbar-none min-w-0 flex-1">
          {/* Render panel tabs */}
          {sortedPanels.map((panel, index) => {
          const isPermanent = panel.metadata?.permanent === true;
          const isEditing = editingPanelId === panel.id;
          const isDiffPanel = panel.type === 'diff';
          const displayTitle = isDiffPanel ? 'Diff' : panel.title;
          const shortcutHint = index < 9 ? hotkeyDisplay(`panel-tab-${index + 1}`) ?? undefined : undefined;

          const tab = (
            <div
              className={cn(
                "group relative inline-flex items-center h-[var(--panel-tab-height)] min-w-[8rem] justify-center px-3 pr-7 text-sm whitespace-nowrap cursor-pointer select-none",
                activePanel?.id === panel.id
                  ? "text-text-primary"
                  : "text-text-tertiary hover:text-text-primary hover:bg-surface-hover"
              )}
              onClick={() => !isEditing && handlePanelClick(panel)}
              onDoubleClick={(e) => {
                if (!isEditing && !isPermanent && !isDiffPanel) {
                  handleStartRename(e, panel);
                }
              }}
              role="tab"
              aria-selected={activePanel?.id === panel.id}
              tabIndex={activePanel?.id === panel.id ? 0 : -1}
              onKeyDown={(e) => {
                if (isEditing) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handlePanelClick(panel);
                }
              }}
            >
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={handleRenameSubmit}
                  className="px-1 text-sm bg-bg-primary border border-border-primary rounded outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-text-primary"
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: `${Math.max(50, editingTitle.length * 8)}px` }}
                />
              ) : (
                <span className="inline-flex items-center justify-center gap-2 text-sm min-w-0">
                  {getPanelIcon(panel.type, panel)}
                  <span>{displayTitle}</span>
                </span>
              )}

              {!isPermanent && !isEditing && (
                <button
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity transition-colors text-text-muted hover:bg-surface-hover hover:text-status-error focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
                  onClick={(e) => handlePanelClose(e, panel)}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          );

          return shortcutHint ? (
            <Tooltip
              key={panel.id}
              content={
                <span className="flex flex-col items-start gap-1">
                  <span className="text-text-secondary">{displayTitle}</span>
                  <Kbd size="xs" variant="muted" className="origin-left scale-[0.8]">{shortcutHint}</Kbd>
                </span>
              }
              side="bottom"
            >
              {tab}
            </Tooltip>
          ) : <React.Fragment key={panel.id}>{tab}</React.Fragment>;
        })}

        </div>

        {/* Add Panel dropdown button - outside overflow container so dropdown isn't clipped */}
        <div className="relative h-[var(--panel-tab-height)] flex items-center flex-shrink-0" ref={dropdownRef}>
          <Tooltip content={hotkeyDisplay('open-add-tool') ? <Kbd>{hotkeyDisplay('open-add-tool')}</Kbd> : undefined} side="bottom">
            <button
              className="inline-flex items-center h-[var(--panel-tab-height)] px-3 text-sm text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
              onClick={() => setShowDropdown(!showDropdown)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && !showDropdown) {
                  e.preventDefault();
                  setShowDropdown(true);
                }
              }}
              aria-haspopup="menu"
              aria-expanded={showDropdown}
            >
              <Plus className="w-4 h-4 mr-1" />
              Add Tool
              <ChevronDown className="w-3 h-3 ml-1" />
            </button>
          </Tooltip>

          {showDropdown && (() => {
            // Track ref index for keyboard navigation
            let refIndex = 0;
            const menuItemClass = "flex items-start w-full px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus:bg-surface-hover focus:text-text-primary focus:outline-none text-left";

            return createPortal(
            <div
              ref={dropdownMenuRef}
              className="bg-surface-primary border border-border-primary rounded shadow-dropdown z-50 animate-dropdown-enter"
              style={dropdownStyle}
              role="menu"
              onKeyDown={handleDropdownKeyDown}
            >
              {/* Terminal - plain terminal */}
              {availablePanelTypes.includes('terminal') && (
                <button
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('terminal')}
                >
                  <Terminal className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span className="ml-2 flex-1 min-w-0">
                    <span className="block">Terminal</span>
                    {hotkeyDisplay('add-tool-terminal') && <Kbd size="xs" variant="muted" className="mt-1 origin-left scale-[0.7]">{hotkeyDisplay('add-tool-terminal')}</Kbd>}
                  </span>
                </button>
              )}
              {/* Explorer */}
              {availablePanelTypes.includes('explorer') && (
                <button
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('explorer')}
                >
                  <FolderTree className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span className="ml-2 flex-1 min-w-0">
                    <span className="block">Explorer</span>
                    {hotkeyDisplay('add-tool-explorer') && <Kbd size="xs" variant="muted" className="mt-1 origin-left scale-[0.7]">{hotkeyDisplay('add-tool-explorer')}</Kbd>}
                  </span>
                </button>
              )}
              {/* Claude Code */}
              {availablePanelTypes.includes('terminal') && (
                <button
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('terminal', {
                    initialCommand: 'claude --dangerously-skip-permissions',
                    title: 'Claude Code'
                  })}
                >
                  <ClaudeIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span className="ml-2 flex-1 min-w-0">
                    <span className="block">Claude Code</span>
                    {hotkeyDisplay('add-tool-terminal-claude') && <Kbd size="xs" variant="muted" className="mt-1 origin-left scale-[0.7]">{hotkeyDisplay('add-tool-terminal-claude')}</Kbd>}
                  </span>
                </button>
              )}
              {/* Codex */}
              {availablePanelTypes.includes('terminal') && (
                <button
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('terminal', {
                    initialCommand: 'codex',
                    title: 'Codex'
                  })}
                >
                  <OpenAIIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span className="ml-2 flex-1 min-w-0">
                    <span className="block">Codex</span>
                    {hotkeyDisplay('add-tool-terminal-codex') && <Kbd size="xs" variant="muted" className="mt-1 origin-left scale-[0.7]">{hotkeyDisplay('add-tool-terminal-codex')}</Kbd>}
                  </span>
                </button>
              )}
              {/* Saved custom commands */}
              {availablePanelTypes.includes('terminal') && customCommands.map((cmd, index) => {
                const currentRefIndex = refIndex++;
                const shortcutDisplay = hotkeyDisplay(`add-tool-custom-${index}`);
                return (
                <button
                  key={`custom-${index}`}
                  ref={(el) => { dropdownItemsRef.current[currentRefIndex] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('terminal', {
                    initialCommand: cmd.command,
                    title: cmd.name
                  })}
                  onKeyDown={(e) => {
                    // Delete or Backspace removes the custom command
                    if (e.key === 'Delete' || e.key === 'Backspace') {
                      e.preventDefault();
                      e.stopPropagation();
                      deleteCustomCommand(index);
                    }
                  }}
                  title={`${cmd.name} (Delete/Backspace to remove)`}
                >
                  {getCliBrandIcon(cmd.command, 'w-4 h-4 flex-shrink-0 mt-0.5') || <TerminalSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                  <span className="ml-2 flex-1 min-w-0">
                    <span className="block truncate">{cmd.name}</span>
                    {shortcutDisplay && <Kbd size="xs" variant="muted" className="mt-1 origin-left scale-[0.7]">{shortcutDisplay}</Kbd>}
                  </span>
                </button>
              );})}
              {/* Add Custom Command input */}
              {availablePanelTypes.includes('terminal') && (
                showCustomInput ? (
                  <div className="px-3 py-2 border-b border-border-primary">
                    <label className="text-xs text-text-tertiary mb-1 block">Command to run:</label>
                    <input
                      ref={(el) => { customInputRef.current = el; dropdownItemsRef.current[refIndex++] = el; }}
                      type="text"
                      className="w-full px-2 py-1.5 text-sm bg-surface-secondary border border-border-primary rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                      placeholder="e.g. aider, npm run dev, bash"
                      value={customCommand}
                      onChange={(e) => setCustomCommand(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && customCommand.trim()) {
                          const command = customCommand.trim();
                          const name = command.split(/\s+/).slice(0, 3).join(' ');
                          saveCustomCommand(name, command);
                          handleAddPanel('terminal', {
                            initialCommand: command,
                            title: name
                          });
                          setCustomCommand('');
                          setShowCustomInput(false);
                        }
                        if (e.key === 'Escape') {
                          setShowCustomInput(false);
                          setCustomCommand('');
                        }
                        // Let arrow keys propagate for dropdown navigation
                      }}
                    />
                  </div>
                ) : (
                  <button
                    ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                    role="menuitem"
                    className={`${menuItemClass} border-b border-border-primary`}
                    onClick={() => setShowCustomInput(true)}
                  >
                    <Plus className="w-4 h-4 flex-shrink-0" />
                    <span className="ml-2">Add Custom Command...</span>
                  </button>
                )
              )}
              {/* Other panel types (excluding terminal and explorer, already listed above) */}
              {availablePanelTypes.filter(t => t !== 'terminal' && t !== 'explorer').map((type) => {
                const currentRefIndex = refIndex++;
                return (
                <button
                  key={type}
                  ref={(el) => { dropdownItemsRef.current[currentRefIndex] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel(type)}
                >
                  {getPanelIcon(type)}
                  <span className="ml-2 capitalize">{type}</span>
                </button>
              );})}
            </div>,
            document.body
            );
          })()}
        </div>

        {/* Right side actions */}
        <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
          {/* Resource monitor chip */}
          <button
            ref={resourceChipRef}
            onClick={toggleResourcePopover}
            className={cn(
              "inline-flex items-center gap-1.5 h-[var(--panel-tab-height)] px-2.5 rounded text-xs font-mono transition-colors flex-shrink-0",
              showResourcePopover
                ? "text-text-primary bg-surface-hover"
                : "text-text-tertiary hover:text-text-primary hover:bg-surface-hover"
            )}
            title="Resource Usage"
          >
            <Cpu className="w-3.5 h-3.5" />
            {snapshot && (
              <>
                {snapshot.cpuReady && (
                  <>
                    <span>{snapshot.totalCpuPercent.toFixed(0)}%</span>
                    <span className="text-text-quaternary">|</span>
                  </>
                )}
                <span>{formatMemory(snapshot.totalMemoryMB)}</span>
              </>
            )}
          </button>

          {/* Run Dev Server button */}
          {session && (
            <Tooltip content="Run Dev Server" side="bottom">
              <button
                className="inline-flex items-center justify-center h-[var(--panel-tab-height)] px-2.5 rounded text-text-tertiary hover:text-status-success hover:bg-surface-hover transition-colors flex-shrink-0"
                onClick={async () => {
                  const scriptExists = await window.electronAPI?.invoke('file:exists', {
                    sessionId: session.id,
                    filePath: 'scripts/pane-run-script.js'
                  });

                  if (scriptExists) {
                    handleAddPanel('terminal', {
                      initialCommand: 'node scripts/pane-run-script.js',
                      title: 'Dev Server'
                    });
                  } else {
                    handleAddPanel('terminal', {
                      initialCommand: `claude --dangerously-skip-permissions "${SETUP_RUN_SCRIPT_PROMPT.replace(/\n/g, ' ')}"`,
                      title: 'Setup Run Script'
                    });
                  }
                }}
                title="Run Dev Server"
              >
                <Play className="w-4 h-4" />
              </button>
            </Tooltip>
          )}

          {/* Detail panel toggle */}
          {onToggleDetailPanel && (
            <Tooltip content={hotkeyDisplay('toggle-detail-panel') ? <Kbd>{hotkeyDisplay('toggle-detail-panel')}</Kbd> : undefined} side="bottom">
              <button
                onClick={onToggleDetailPanel}
                className={cn(
                  "inline-flex items-center justify-center h-[var(--panel-tab-height)] px-2.5 rounded transition-colors flex-shrink-0",
                  detailPanelVisible
                    ? "text-text-primary bg-surface-hover"
                    : "text-text-tertiary hover:text-text-primary hover:bg-surface-hover"
                )}
                title={detailPanelVisible ? "Hide detail panel" : "Show detail panel"}
              >
                <PanelRight className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>

    {/* Resource monitor popover */}
    {showResourcePopover && snapshot && createPortal(
      <div
        ref={resourcePopoverRef}
        className="bg-surface-primary border border-border-subtle/60 rounded-lg shadow-dropdown-elevated backdrop-blur-sm animate-dropdown-enter overflow-hidden w-[320px]"
        style={popoverStyle}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border-secondary">
          <span className="text-[10px] font-semibold text-text-tertiary tracking-wider uppercase">
            Resource Usage
          </span>
          <button
            onClick={handleRefresh}
            className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Summary */}
        <div className="flex items-center gap-4 px-3 py-2 border-b border-border-secondary">
          <span className="text-sm text-text-secondary">
            CPU <strong className="text-text-primary">{snapshot.cpuReady ? `${snapshot.totalCpuPercent.toFixed(1)}%` : '—'}</strong>
          </span>
          <span className="text-sm text-text-secondary">
            Memory <strong className="text-text-primary">{formatMemory(snapshot.totalMemoryMB)}</strong>
          </span>
        </div>

        {/* Scrollable content */}
        <div className="max-h-[400px] overflow-y-auto">
          {/* Pane App section */}
          <div className="border-b border-border-secondary">
            <button
              onClick={() => toggleSection('pane-app')}
              className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-center gap-1.5">
                {expandedSections.has('pane-app')
                  ? <ChevronDown className="w-3 h-3 text-text-quaternary" />
                  : <ChevronRight className="w-3 h-3 text-text-quaternary" />}
                <span className="text-sm font-medium text-text-primary">Pane App</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-text-tertiary font-mono">
                <span>{snapshot.cpuReady ? `${electronTotalCpu.toFixed(1)}%` : '—'}</span>
                <span>{formatMemory(electronTotalMem)}</span>
              </div>
            </button>
            {expandedSections.has('pane-app') && snapshot.electronProcesses.map(p => (
              <div key={p.pid} className="flex items-center justify-between px-3 py-1 pl-8">
                <span className="text-xs text-text-secondary">{p.label}</span>
                <div className="flex items-center gap-3 text-xs text-text-tertiary font-mono">
                  <span>{snapshot.cpuReady ? `${p.cpuPercent.toFixed(1)}%` : '—'}</span>
                  <span>{formatMemory(p.memoryMB)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Per-session sections */}
          {snapshot.sessions.map(sess => (
            <div
              key={sess.sessionId}
              className={cn(
                "border-b border-border-secondary",
                sess.sessionId === session?.id && "bg-interactive/5"
              )}
            >
              <button
                onClick={() => toggleSection(sess.sessionId)}
                className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-surface-hover transition-colors"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {expandedSections.has(sess.sessionId)
                    ? <ChevronDown className="w-3 h-3 text-text-quaternary flex-shrink-0" />
                    : <ChevronRight className="w-3 h-3 text-text-quaternary flex-shrink-0" />}
                  {sess.sessionId === session?.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-interactive flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium text-text-primary truncate">{sess.sessionName}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-text-tertiary font-mono flex-shrink-0 ml-2">
                  <span>{snapshot.cpuReady ? `${sess.totalCpuPercent.toFixed(1)}%` : '—'}</span>
                  <span>{formatMemory(sess.totalMemoryMB)}</span>
                </div>
              </button>
              {expandedSections.has(sess.sessionId) && sess.children.map(child => (
                <div key={child.pid} className="flex items-center justify-between px-3 py-1 pl-8">
                  <span className="text-xs text-text-secondary truncate">{child.name}</span>
                  <div className="flex items-center gap-3 text-xs text-text-tertiary font-mono flex-shrink-0 ml-2">
                    <span>{snapshot.cpuReady ? `${child.cpuPercent.toFixed(1)}%` : '—'}</span>
                    <span>{formatMemory(child.memoryMB)}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>,
      document.body
    )}
    </>
  );
});

PanelTabBar.displayName = 'PanelTabBar';
