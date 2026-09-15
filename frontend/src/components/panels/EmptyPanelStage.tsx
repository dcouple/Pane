import { Terminal, TerminalSquare } from 'lucide-react';
import type { PanelTabBarProps } from '../../types/panelComponents';
import { useConfigStore } from '../../stores/configStore';
import { useHotkeyStore } from '../../stores/hotkeyStore';
import { visibleAgentPresets } from '../../utils/agentPresets';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { getCliBrandIcon } from '../ui/brandIconRegistry';
import { Kbd } from '../ui/Kbd';

type EmptyPanelStageProps = Pick<PanelTabBarProps, 'projectEnvironment' | 'onPanelCreate'>;

// The empty stage is the "+" menu laid out inline, shared by repo and worktree views.
export function EmptyPanelStage({ projectEnvironment, onPanelCreate }: EmptyPanelStageProps) {
  const config = useConfigStore((s) => s.config);
  const customCommands = (config?.customCommands ?? []).filter(cmd => cmd?.name && cmd?.command);
  const agentPresets = visibleAgentPresets(projectEnvironment);
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = (id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  };

  return (
    <div className="flex h-full flex-1 items-center justify-center">
      <div className="w-64">
        <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Open</div>
        {[
          { key: 'terminal', label: 'Terminal', icon: <Terminal className="h-3.5 w-3.5" />, hotkeyId: 'add-tool-terminal', onClick: () => onPanelCreate('terminal') },
          ...agentPresets.map(preset => ({
            key: preset.id,
            label: preset.title,
            icon: getCliBrandIcon(preset.iconKey, 'h-3.5 w-3.5'),
            hotkeyId: preset.hotkeyId,
            onClick: () => onPanelCreate('terminal', { initialCommand: preset.command, title: preset.title }),
          })),
          ...customCommands.map((cmd, index) => ({
            key: `custom-${index}`,
            label: cmd.name,
            icon: getCliBrandIcon(cmd.command, 'h-3.5 w-3.5') || <TerminalSquare className="h-3.5 w-3.5" />,
            hotkeyId: `add-tool-custom-${index}`,
            onClick: () => onPanelCreate('terminal', { initialCommand: cmd.command, title: cmd.name }),
          })),
        ].map(item => (
          <button
            key={item.key}
            type="button"
            onClick={item.onClick}
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
          >
            <span className="flex-shrink-0 text-text-tertiary">{item.icon}</span>
            <span className="truncate">{item.label}</span>
            {hotkeyDisplay(item.hotkeyId) && <Kbd variant="inline" className="ml-auto pl-3">{hotkeyDisplay(item.hotkeyId)}</Kbd>}
          </button>
        ))}
      </div>
    </div>
  );
}
