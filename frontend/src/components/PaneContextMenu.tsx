import { Archive, Pencil, Pin } from 'lucide-react';
import type { Session } from '../types/session';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';

export interface PaneContextMenuState {
  session: Session;
  label: string;
  x: number;
  y: number;
}

interface PaneContextMenuProps {
  menu: PaneContextMenuState | null;
  onClose: () => void;
  onRename: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
}

export function PaneContextMenu({
  menu,
  onClose,
  onRename,
  onTogglePinned,
  onArchive,
}: PaneContextMenuProps) {
  return (
    <TerminalPopover
      visible={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={onClose}
    >
      <div role="menu" aria-label={`Pane actions for ${menu?.session.name || 'Untitled'}`}>
        <PopoverButton role="menuitem" onClick={onRename}>
          <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename</span>
        </PopoverButton>
        <PopoverButton role="menuitem" onClick={onTogglePinned}>
          <span className="flex items-center gap-2">
            <Pin className="h-4 w-4 rotate-45" />
            {menu?.session.isFavorite ? 'Unpin' : 'Pin'}
          </span>
        </PopoverButton>
        <div className="my-1 border-t border-border-primary" />
        <PopoverButton role="menuitem" variant="danger" onClick={onArchive}>
          <span className="flex items-center gap-2"><Archive className="h-4 w-4" />Archive</span>
        </PopoverButton>
      </div>
    </TerminalPopover>
  );
}
