import React, { useRef, useState, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';
import { TerminalSuggestion } from '../../services/terminalInterceptor/types';

interface InterceptorDropdownProps {
  visible: boolean;
  terminals: TerminalSuggestion[];
  selectedIndex: number;
  lineCount: number;
  isEditingLineCount: boolean;
  lineCountInput: string;
  filterText: string;
  position: { x: number; y: number };
}

export const InterceptorDropdown: React.FC<InterceptorDropdownProps> = ({
  visible,
  terminals,
  selectedIndex,
  lineCount,
  isEditingLineCount,
  lineCountInput,
  filterText,
  position,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);
  const [resolvedPosition, setResolvedPosition] = useState({ top: 0, left: 0 });

  // Smart positioning to keep dropdown on screen
  useLayoutEffect(() => {
    if (!visible || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    let top = position.y;
    let left = position.x;

    // Flip up if near bottom
    if (top + rect.height > viewportHeight - 10) {
      top = position.y - rect.height;
    }

    // Keep on screen horizontally
    if (left + rect.width > viewportWidth - 10) {
      left = viewportWidth - rect.width - 10;
    }

    // Don't go off left edge
    if (left < 10) {
      left = 10;
    }

    // Don't go off top edge
    if (top < 10) {
      top = 10;
    }

    setResolvedPosition({ top, left });
  }, [visible, position.x, position.y]);

  // Scroll the selected item into view
  useEffect(() => {
    if (!visible || !selectedItemRef.current) return;
    selectedItemRef.current.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, visible]);

  if (!visible) return null;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed z-[10001] bg-surface-primary border border-border-primary rounded-lg shadow-dropdown-elevated py-1 min-w-[280px] max-w-[400px]"
      style={{ left: resolvedPosition.left, top: resolvedPosition.top }}
    >
      {/* Header */}
      <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border-subtle flex justify-between items-center">
        <span className="font-mono">@{filterText}</span>
        {isEditingLineCount ? (
          <span className="font-mono text-text-primary">:{lineCountInput}</span>
        ) : (
          <span className="font-mono text-text-tertiary">:{lineCount}</span>
        )}
      </div>

      {/* Terminal entries */}
      {terminals.map((terminal, index) => {
        const isSelected = index === selectedIndex;
        const isNoOutput =
          terminal.preview.length === 1 && terminal.preview[0] === '(no output)';

        return (
          <div
            key={terminal.panelId}
            ref={isSelected ? selectedItemRef : null}
            className={cn('px-3 py-2 cursor-default', isSelected && 'bg-bg-hover')}
          >
            <div className="text-sm font-medium text-text-primary">{terminal.title}</div>
            <div className="text-xs text-text-tertiary font-mono mt-1 leading-relaxed whitespace-pre overflow-hidden max-h-[5lh]">
              {isNoOutput ? (
                <span className="italic">{terminal.preview[0]}</span>
              ) : (
                terminal.preview.join('\n')
              )}
            </div>
          </div>
        );
      })}

      {/* Footer hint */}
      <div className="px-3 py-1.5 text-xs text-text-quaternary border-t border-border-subtle">
        ↑↓ navigate · Enter copy · :N lines · Esc cancel
      </div>
    </div>,
    document.body
  );
};

InterceptorDropdown.displayName = 'InterceptorDropdown';
