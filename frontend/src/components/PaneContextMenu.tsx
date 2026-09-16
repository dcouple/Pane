import { useRef, useState } from 'react';
import { Archive, Pencil, Pin } from 'lucide-react';
import type { Session } from '../types/session';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';

export interface PaneContextMenuState {
  session: Session;
  opener: HTMLElement;
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
      {menu && (
        <PaneContextMenuBody
          key={`${menu.session.id}:${menu.x}:${menu.y}`}
          menu={menu}
          onClose={onClose}
          onRename={onRename}
          onTogglePinned={onTogglePinned}
          onArchive={onArchive}
        />
      )}
    </TerminalPopover>
  );
}

function PaneContextMenuBody({
  menu,
  onClose,
  onRename,
  onTogglePinned,
  onArchive,
}: Omit<PaneContextMenuProps, 'menu'> & { menu: PaneContextMenuState }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const activeIndex = Math.max(0, items.findIndex(item => item === document.activeElement));

    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      setFocusedIndex(nextIndex);
      items[nextIndex]?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      items[activeIndex]?.click();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const opener = menu.opener;
      onClose();
      requestAnimationFrame(() => opener?.focus());
      return;
    }
    if (event.key === 'Tab') onClose();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Pane actions for ${menu.session.name || 'Untitled'}`}
      onKeyDown={handleKeyDown}
    >
      <PopoverButton autoFocus role="menuitem" tabIndex={focusedIndex === 0 ? 0 : -1} onFocus={() => setFocusedIndex(0)} onClick={onRename}>
        <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename</span>
      </PopoverButton>
      <PopoverButton role="menuitem" tabIndex={focusedIndex === 1 ? 0 : -1} onFocus={() => setFocusedIndex(1)} onClick={onTogglePinned}>
        <span className="flex items-center gap-2">
          <Pin className="h-4 w-4 rotate-45" />
          {menu.session.isFavorite ? 'Unpin' : 'Pin'}
        </span>
      </PopoverButton>
      <div className="my-1 border-t border-border-primary" />
      <PopoverButton role="menuitem" tabIndex={focusedIndex === 2 ? 0 : -1} onFocus={() => setFocusedIndex(2)} variant="danger" onClick={onArchive}>
        <span className="flex items-center gap-2"><Archive className="h-4 w-4" />Archive</span>
      </PopoverButton>
    </div>
  );
}
