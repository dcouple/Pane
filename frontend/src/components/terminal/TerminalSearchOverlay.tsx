import React from 'react';
import type { TerminalSearchResult } from '../../utils/terminalSearch';

interface TerminalSearchOverlayProps {
  isOpen: boolean;
  searchQuery: string;
  searchStatus: TerminalSearchResult;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
  onStep: (direction: 'next' | 'prev') => void;
  onClose: () => void;
}

const TerminalSearchOverlay: React.FC<TerminalSearchOverlayProps> = ({
  isOpen,
  searchQuery,
  searchStatus,
  searchInputRef,
  onQueryChange,
  onStep,
  onClose,
}) => {
  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Prevent keystrokes from reaching the terminal underneath
    e.stopPropagation();

    if (e.key === 'Enter') {
      if (e.shiftKey) {
        onStep('prev');
      } else {
        onStep('next');
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const matchLabel =
    searchStatus.total === 0
      ? '0/0'
      : `${searchStatus.currentIndex + 1}/${searchStatus.total}`;

  return (
    <div className="absolute top-5 right-3 z-20 flex items-center gap-1 p-1.5 rounded border border-border-primary bg-surface-secondary shadow">
      {/* Search input */}
      <input
        ref={searchInputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
        autoFocus
        className="text-xs bg-surface-primary border border-border-primary text-text-primary placeholder:text-text-tertiary rounded px-2 py-0.5 outline-none focus:border-border-primary w-36"
      />

      {/* Match counter */}
      <span className="text-text-tertiary text-xs min-w-[3rem] text-center select-none">
        {matchLabel}
      </span>

      {/* Previous match */}
      <button
        onClick={() => onStep('prev')}
        title="Previous match (Shift+Enter)"
        className="p-1 rounded text-text-secondary hover:bg-surface-tertiary hover:text-text-primary transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8.5L7 5L11 8.5" />
        </svg>
      </button>

      {/* Next match */}
      <button
        onClick={() => onStep('next')}
        title="Next match (Enter)"
        className="p-1 rounded text-text-secondary hover:bg-surface-tertiary hover:text-text-primary transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 5.5L7 9L11 5.5" />
        </svg>
      </button>

      {/* Close */}
      <button
        onClick={onClose}
        title="Close search (Escape)"
        className="p-1 rounded text-text-secondary hover:bg-surface-tertiary hover:text-text-primary transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="3" y1="3" x2="11" y2="11" />
          <line x1="11" y1="3" x2="3" y2="11" />
        </svg>
      </button>
    </div>
  );
};

TerminalSearchOverlay.displayName = 'TerminalSearchOverlay';

export default React.memo(TerminalSearchOverlay);
export { TerminalSearchOverlay };
export type { TerminalSearchOverlayProps };
