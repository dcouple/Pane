import { ChevronDown, Plus, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RemotePwaCustomCommand } from '../../../../shared/types/remoteDaemon';
import type { ToolPanel } from '../../../../shared/types/panels';
import { ClaudeIcon, getCliBrandIcon, OpenAIIcon } from '../../components/ui/BrandIcons';

export interface RemoteTerminalCreateOptions {
  title?: string;
  initialCommand?: string;
}

interface RemotePanelTabsProps {
  panels: ToolPanel[];
  selectedPanelId: string | null;
  creating: boolean;
  customCommands: RemotePwaCustomCommand[];
  onSelectPanel: (panelId: string) => void;
  onCreateTerminal: (options?: RemoteTerminalCreateOptions) => void;
}

export function RemotePanelTabs({
  panels,
  selectedPanelId,
  creating,
  customCommands,
  onSelectPanel,
  onCreateTerminal,
}: RemotePanelTabsProps) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showAddMenu) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setShowAddMenu(false);
      }
    };

    window.addEventListener('pointerdown', closeOnPointerDown);
    return () => window.removeEventListener('pointerdown', closeOnPointerDown);
  }, [showAddMenu]);

  const addTerminal = (options?: RemoteTerminalCreateOptions) => {
    onCreateTerminal(options);
    setShowAddMenu(false);
  };

  return (
    <div className="flex min-h-12 shrink-0 items-end gap-2 border-b border-border-primary bg-bg-secondary px-2 pt-2">
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
        {panels.map(panel => (
          <button
            key={panel.id}
            type="button"
            onClick={() => onSelectPanel(panel.id)}
            className={`relative flex h-10 max-w-[min(12rem,55vw)] shrink-0 items-center gap-2 rounded-t-lg border px-3 text-sm font-medium shadow-sm transition-colors ${
              selectedPanelId === panel.id
                ? 'border-border-primary border-b-bg-primary bg-bg-primary text-text-primary shadow-[0_-1px_0_rgba(255,255,255,0.04)_inset]'
                : 'border-border-secondary bg-surface-primary text-text-secondary hover:border-border-primary hover:bg-surface-hover hover:text-text-primary'
            }`}
          >
            <TerminalSquare className="h-4 w-4 shrink-0" />
            <span className="truncate">{panel.title}</span>
          </button>
        ))}
      </div>

      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setShowAddMenu(value => !value)}
          disabled={creating}
          className="mb-1.5 flex h-8 shrink-0 items-center gap-1 rounded-md border border-border-secondary bg-surface-primary px-2 text-sm font-medium text-text-secondary shadow-sm hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 sm:px-3"
          aria-haspopup="menu"
          aria-expanded={showAddMenu}
          aria-label="Add tool"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Add Tool</span>
          <ChevronDown className="hidden h-3 w-3 sm:block" />
        </button>

        {showAddMenu && (
          <div
            className="absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border-primary bg-surface-primary shadow-dropdown"
            role="menu"
          >
            <AddToolMenuItem
              icon={<TerminalSquare className="h-4 w-4" />}
              title="Terminal"
              description="Start a shell on the remote host"
              onClick={() => addTerminal()}
            />
            <AddToolMenuItem
              icon={<ClaudeIcon className="h-4 w-4" />}
              title="Claude Code"
              description="Run claude --dangerously-skip-permissions"
              onClick={() => addTerminal({
                title: 'Claude Code',
                initialCommand: 'claude --dangerously-skip-permissions',
              })}
            />
            <AddToolMenuItem
              icon={<OpenAIIcon className="h-4 w-4" />}
              title="Codex"
              description="Run codex --yolo"
              onClick={() => addTerminal({
                title: 'Codex',
                initialCommand: 'codex --yolo',
              })}
            />
            {customCommands.map((command, index) => (
              <AddToolMenuItem
                key={`${command.name}-${index}`}
                icon={getCliBrandIcon(command.command, 'h-4 w-4') ?? <TerminalSquare className="h-4 w-4" />}
                title={command.name}
                description={command.command}
                onClick={() => addTerminal({
                  title: command.name,
                  initialCommand: command.command,
                })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AddToolMenuItem({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
    >
      <span className="mt-0.5 shrink-0 text-text-tertiary">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium text-text-primary">{title}</span>
        <span className="block truncate text-xs text-text-tertiary">{description}</span>
      </span>
    </button>
  );
}
