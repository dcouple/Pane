import { ChevronDown, ChevronUp, Terminal, X } from 'lucide-react';
import type { ToolPanel } from '../../../../shared/types/panels';
import { useOuterPanelResize } from '../../hooks/useOuterPanelResize';
import { OUTER_PANEL_CONFIGS } from '../../utils/outerPanelSizing';
import { OuterResizeSeparator } from '../ui/OuterResizeSeparator';
import { PanelContainer } from './PanelContainer';

interface TerminalDockProps {
  panel: ToolPanel;
  availableHeight: number;
  collapsed: boolean;
  hidden: boolean;
  onToggle: () => void;
  onClose: () => void;
  isMainRepo: boolean;
}

export function TerminalDock({ panel, availableHeight, collapsed, hidden, onToggle, onClose, isMainRepo }: TerminalDockProps) {
  const resize = useOuterPanelResize({
    config: OUTER_PANEL_CONFIGS.bottomTerminal,
    containerPx: availableHeight,
    enabled: !collapsed && !hidden,
  });
  const height = hidden ? 0 : collapsed ? Math.min(32, availableHeight) : resize.renderedPx;
  const contentActive = height > 0;

  return (
    <div
      className={`pane-terminal-dock flex-shrink-0 flex flex-col relative overflow-visible ${
        !hidden && (collapsed || resize.renderedPx > 0) ? 'border-t border-border-primary' : ''
      }`}
      style={{ height: `${height}px` }}
    >
      {resize.separatorVisible && (
        <OuterResizeSeparator
          label="Resize terminal"
          orientation="horizontal"
          value={resize.effectivePx}
          minimum={resize.floor}
          maximum={resize.cap}
          {...resize.separatorHandlers}
        />
      )}
      <div
        className="pane-terminal-dock-content flex flex-col h-full min-h-0 overflow-hidden"
        aria-hidden={!contentActive}
        inert={!contentActive ? true : undefined}
      >
        <div className="pane-terminal-shell-header flex items-center h-8 px-3 bg-surface-primary border-b border-border-primary gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand terminal' : 'Collapse terminal'}
            className="p-0.5 hover:bg-surface-hover rounded transition-colors"
            title={collapsed ? 'Expand terminal' : 'Collapse terminal'}
          >
            {collapsed ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" /> : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
          </button>
          <Terminal className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wider">Terminal</span>
          <div className="flex-1" />
          {!panel.metadata.permanent && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close terminal"
              title="Close terminal"
              className="p-0.5 hover:bg-surface-hover rounded transition-colors"
            >
              <X className="w-3.5 h-3.5 text-text-tertiary" />
            </button>
          )}
        </div>
        {!collapsed && (
          <div
            className="pane-terminal-shell-body flex-1 min-h-0 relative pb-1"
            style={{ display: resize.bodyActive ? 'block' : 'none' }}
            aria-hidden={!resize.bodyActive}
            inert={!resize.bodyActive ? true : undefined}
          >
            <PanelContainer panel={panel} isActive={resize.bodyActive} autoFocus={false} isMainRepo={isMainRepo} />
          </div>
        )}
      </div>
    </div>
  );
}
