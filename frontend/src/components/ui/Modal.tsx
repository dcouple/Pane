import React, { createContext, useContext, useEffect, useId, useRef } from 'react';
import { cn } from '../../utils/cn';
import { X } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  ariaLabel?: string;
  className?: string;
}

const ModalTitleContext = createContext<string | undefined>(undefined);
const modalStack: HTMLDivElement[] = [];
let openModalCount = 0;
let originalBodyOverflow = '';

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  children,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  ariaLabel,
  className,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const mouseDownTargetRef = useRef<EventTarget | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  
  // Handle escape key
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && modalStack.at(-1) === modalRef.current) {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, closeOnEscape]);
  
  // Lock body scroll when modal is open
  useEffect(() => {
    if (!isOpen) return;
    if (openModalCount === 0) originalBodyOverflow = document.body.style.overflow;
    openModalCount += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      openModalCount = Math.max(0, openModalCount - 1);
      if (openModalCount === 0) document.body.style.overflow = originalBodyOverflow;
    };
  }, [isOpen]);
  
  // Focus management and restoration.
  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = modalRef.current;
    const previousModal = modalStack.at(-1);
    if (previousModal) {
      previousModal.inert = true;
      previousModal.setAttribute('aria-hidden', 'true');
    }
    if (modal) modalStack.push(modal);
    const keepFocusInTopModal = (event: FocusEvent) => {
      const target = event.target;
      if (
        !modal
        || modalStack.at(-1) !== modal
        || !(target instanceof HTMLElement)
        || modal.contains(target)
        || target.closest('[data-radix-popper-content-wrapper]')
      ) return;
      const firstFocusable = modal.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (firstFocusable ?? modal).focus();
    };
    document.addEventListener('focusin', keepFocusInTopModal);
    const timer = setTimeout(() => {
      const firstFocusable = modalRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (firstFocusable ?? modalRef.current)?.focus();
    }, 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', keepFocusInTopModal);
      const index = modal ? modalStack.lastIndexOf(modal) : -1;
      if (index >= 0) modalStack.splice(index, 1);
      const nextModal = modalStack.at(-1);
      if (nextModal) {
        nextModal.inert = false;
        nextModal.removeAttribute('aria-hidden');
      }
      window.setTimeout(() => previouslyFocusedRef.current?.focus(), 0);
    };
  }, [isOpen]);
  
  if (!isOpen) return null;
  
  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-full mx-4',
  };
  
  const handleOverlayMouseDown = (e: React.MouseEvent) => {
    // Store where the mouse down occurred
    mouseDownTargetRef.current = e.target;
  };
  
  const handleOverlayClick = (e: React.MouseEvent) => {
    // If click target was removed from DOM (e.g. portal dropdown closed), don't close
    if (e.target instanceof Node && !document.body.contains(e.target)) return;

    // Check if the click target is the modal content or its children
    const modalContent = modalRef.current;
    const isClickInsideModal = modalContent && e.target && e.target instanceof Node && modalContent.contains(e.target);
    
    // Only close if:
    // 1. closeOnOverlayClick is enabled
    // 2. The click is not inside the modal content
    // 3. The mousedown also started outside the modal content
    if (closeOnOverlayClick && !isClickInsideModal) {
      const wasMouseDownInsideModal = modalContent && mouseDownTargetRef.current && mouseDownTargetRef.current instanceof Node && modalContent.contains(mouseDownTargetRef.current);
      if (!wasMouseDownInsideModal) {
        onClose();
      }
    }
    // Reset the ref after handling
    mouseDownTargetRef.current = null;
  };

  const handleModalKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || modalStack.at(-1) !== modalRef.current) return;
    const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      modalRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  
  return (
    <div
      className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 overflow-y-auto"
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-modal-overlay backdrop-blur-sm pointer-events-none" aria-hidden="true" />
      
      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        tabIndex={-1}
        onKeyDown={handleModalKeyDown}
        className={cn(
          'relative bg-bg-primary rounded-modal shadow-modal w-full max-h-[90vh] overflow-hidden flex flex-col',
          sizeClasses[size],
          'animate-fadeIn',
          className
        )}
      >
        {showCloseButton && (
          <div className="absolute top-4 right-4 z-10">
            <button
              type="button"
              aria-label="Close modal"
              onClick={onClose}
              className="text-text-tertiary hover:text-text-secondary transition-colors p-1 rounded"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        <ModalTitleContext.Provider value={titleId}>{children}</ModalTitleContext.Provider>
      </div>
    </div>
  );
};

Modal.displayName = 'Modal';

// Modal Header component
export interface ModalHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  icon?: React.ReactNode;
  onClose?: () => void;
  children?: React.ReactNode;
}

export const ModalHeader = React.forwardRef<HTMLDivElement, ModalHeaderProps>(
  ({ className, title, icon, onClose, children, ...props }, ref) => {
    const titleId = useContext(ModalTitleContext);
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-between px-6 py-4 border-b border-border-primary',
          className
        )}
        {...props}
      >
        <div className="flex items-center gap-2">
          {icon && <div className="text-text-secondary">{icon}</div>}
          <h2 id={titleId} className="text-heading-2 text-text-primary">
            {title || children}
          </h2>
        </div>
        {onClose && (
          <button
            type="button"
            aria-label="Close modal"
            onClick={onClose}
            className="text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>
    );
  }
);

ModalHeader.displayName = 'ModalHeader';

// Modal Body component
export interface ModalBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const ModalBody = React.forwardRef<HTMLDivElement, ModalBodyProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex-1 overflow-y-auto px-6 py-4',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

ModalBody.displayName = 'ModalBody';

// Modal Footer component
export interface ModalFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const ModalFooter = React.forwardRef<HTMLDivElement, ModalFooterProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'px-6 py-4 border-t border-border-primary flex items-center justify-end gap-3',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

ModalFooter.displayName = 'ModalFooter';
