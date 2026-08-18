import React, { useState, useRef, useCallback, useEffect, useId, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '../../utils/cn';
import { usePortalContainer } from '../../contexts/PortalContainerContext';

export interface TooltipProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children' | 'content'> {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  /** When true, the tooltip stays open when hovered so rich text can be selected. */
  interactive?: boolean;
  /** Delay in ms before showing the tooltip (default: 400) */
  delay?: number;
}

const GAP = 6;
type TooltipSide = NonNullable<TooltipProps['side']>;

export const Tooltip = React.forwardRef<HTMLElement, TooltipProps>(({
  content,
  children,
  side = 'top',
  className,
  interactive = false,
  delay = 400,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  onKeyDown,
  ...triggerProps
}, forwardedRef) => {
  const [isOpen, setIsOpen] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const tooltipId = useId();
  const portalContainer = usePortalContainer();
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute position after the tooltip DOM element mounts so we can measure it
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || !tooltipRef.current) return;

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
  }, [isOpen, side]);

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
        setIsOpen(true);
      }, delay);
    } else {
      setStyle({ visibility: 'hidden' });
      setIsOpen(true);
    }
  }, [cancelHide, cancelShow, delay]);

  const hide = useCallback(() => {
    cancelShow();
    if (interactive) {
      // Small delay so user can move mouse from trigger to tooltip
      hideTimeout.current = setTimeout(() => setIsOpen(false), 100);
    } else {
      setIsOpen(false);
    }
  }, [interactive, cancelShow]);

  const dismiss = useCallback(() => {
    cancelHide();
    cancelShow();
    setIsOpen(false);
  }, [cancelHide, cancelShow]);

  useEffect(() => () => {
    cancelHide();
    cancelShow();
  }, [cancelHide, cancelShow]);

  // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
  const existingDescription = (children.props as { 'aria-describedby'?: string })['aria-describedby'];
  const describedBy = [existingDescription, isOpen ? tooltipId : undefined]
    .filter(Boolean)
    .join(' ') || undefined;

  const arrowBorder = {
    top: 'border-l-transparent border-r-transparent border-b-transparent border-t-bg-tertiary',
    bottom: 'border-l-transparent border-r-transparent border-t-transparent border-b-bg-tertiary',
    left: 'border-t-transparent border-b-transparent border-r-transparent border-l-bg-tertiary',
    right: 'border-t-transparent border-b-transparent border-l-transparent border-r-bg-tertiary',
  } satisfies Record<TooltipSide, string>;

  const arrowStyle = {
    top: { bottom: -8, left: '50%', transform: 'translateX(-50%)' },
    bottom: { top: -8, left: '50%', transform: 'translateX(-50%)' },
    left: { right: -8, top: '50%', transform: 'translateY(-50%)' },
    right: { left: -8, top: '50%', transform: 'translateY(-50%)' },
  } satisfies Record<TooltipSide, React.CSSProperties>;

  const setTriggerRef = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
    if (forwardedRef instanceof Function) forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  return (
    <>
      <Slot
        {...triggerProps}
        ref={setTriggerRef}
        className={className}
        aria-describedby={describedBy}
        onMouseEnter={(event) => {
          onMouseEnter?.(event);
          if (!event.defaultPrevented) show();
        }}
        onMouseLeave={(event) => {
          onMouseLeave?.(event);
          if (!event.defaultPrevented) hide();
        }}
        onFocus={(event) => {
          onFocus?.(event);
          if (!event.defaultPrevented) show();
        }}
        onBlur={(event) => {
          onBlur?.(event);
          if (!event.defaultPrevented) hide();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === 'Escape' && isOpen) {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
        }}
      >
        {children}
      </Slot>

      {isOpen && createPortal(
        <div
          id={tooltipId}
          ref={tooltipRef}
          className={cn(
            'fixed z-tooltip px-3 py-1.5 text-sm text-text-primary bg-bg-tertiary border border-border-primary rounded-lg shadow-lg transition-opacity duration-150',
            interactive ? 'whitespace-normal pointer-events-auto' : 'whitespace-nowrap pointer-events-none'
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
        portalContainer ?? document.body
      )}
    </>
  );
});

Tooltip.displayName = 'Tooltip';
