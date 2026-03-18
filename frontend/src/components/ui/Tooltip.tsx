import React, { useState, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  /** When true, the tooltip stays open when hovered and allows interaction (clicks, selection) */
  interactive?: boolean;
  /** Delay in ms before showing the tooltip (default: 400) */
  delay?: number;
}

const GAP = 6;

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = 'top',
  className,
  interactive = false,
  delay = 400,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute position after the tooltip DOM element mounts so we can measure it
  useLayoutEffect(() => {
    if (!isHovered || !triggerRef.current || !tooltipRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tipRect = tooltipRef.current.getBoundingClientRect();

    let top = 0;
    let left = 0;

    switch (side) {
      case 'top':
        top = triggerRect.top - tipRect.height - GAP;
        left = triggerRect.left + (triggerRect.width - tipRect.width) / 2;
        break;
      case 'bottom':
        top = triggerRect.bottom + GAP;
        left = triggerRect.left + (triggerRect.width - tipRect.width) / 2;
        break;
      case 'left':
        top = triggerRect.top + (triggerRect.height - tipRect.height) / 2;
        left = triggerRect.left - tipRect.width - GAP;
        break;
      case 'right':
        top = triggerRect.top + (triggerRect.height - tipRect.height) / 2;
        left = triggerRect.right + GAP;
        break;
    }

    // Clamp to viewport bounds
    const margin = 8;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - tipRect.height - margin));

    setStyle({ top, left, visibility: 'visible', opacity: 1 });
  }, [isHovered, side]);

  const cancelHide = useCallback(() => {
    if (hideTimeout.current) {
      clearTimeout(hideTimeout.current);
      hideTimeout.current = null;
    }
  }, []);

  const cancelShow = useCallback(() => {
    if (showTimeout.current) {
      clearTimeout(showTimeout.current);
      showTimeout.current = null;
    }
  }, []);

  const show = useCallback(() => {
    cancelHide();
    cancelShow();
    if (delay > 0) {
      showTimeout.current = setTimeout(() => {
        setStyle({ visibility: 'hidden' });
        setIsHovered(true);
      }, delay);
    } else {
      setStyle({ visibility: 'hidden' });
      setIsHovered(true);
    }
  }, [cancelHide, cancelShow, delay]);

  const hide = useCallback(() => {
    cancelShow();
    if (interactive) {
      // Small delay so user can move mouse from trigger to tooltip
      hideTimeout.current = setTimeout(() => setIsHovered(false), 100);
    } else {
      setIsHovered(false);
    }
  }, [interactive, cancelShow]);

  const arrowBorder: Record<string, string> = {
    top: 'border-l-transparent border-r-transparent border-b-transparent border-t-bg-tertiary',
    bottom: 'border-l-transparent border-r-transparent border-t-transparent border-b-bg-tertiary',
    left: 'border-t-transparent border-b-transparent border-r-transparent border-l-bg-tertiary',
    right: 'border-t-transparent border-b-transparent border-l-transparent border-r-bg-tertiary',
  };

  const arrowStyle: Record<string, React.CSSProperties> = {
    top: { bottom: -8, left: '50%', transform: 'translateX(-50%)' },
    bottom: { top: -8, left: '50%', transform: 'translateX(-50%)' },
    left: { right: -8, top: '50%', transform: 'translateY(-50%)' },
    right: { left: -8, top: '50%', transform: 'translateY(-50%)' },
  };

  return (
    <div
      ref={triggerRef}
      className={cn('relative inline-block', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}

      {isHovered && createPortal(
        <div
          ref={tooltipRef}
          className={cn(
            'fixed z-[9999] px-3 py-1.5 text-sm text-text-primary bg-bg-tertiary border border-border-primary rounded-lg shadow-lg transition-opacity duration-150',
            interactive ? 'whitespace-normal' : 'whitespace-nowrap pointer-events-none'
          )}
          style={style}
          role="tooltip"
          onMouseEnter={interactive ? cancelHide : undefined}
          onMouseLeave={interactive ? hide : undefined}
        >
          {content}
          <div
            className={cn('absolute w-0 h-0 border-4', arrowBorder[side])}
            style={arrowStyle[side]}
          />
        </div>,
        document.body
      )}
    </div>
  );
};

Tooltip.displayName = 'Tooltip';
