import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';

interface InterceptorToastProps {
  visible: boolean;
  message: string;
  onHide: () => void;
}

export const InterceptorToast: React.FC<InterceptorToastProps> = ({
  visible,
  message,
  onHide,
}) => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => setMounted(true));
    const timer = setTimeout(() => onHide(), 2000);
    return () => {
      clearTimeout(timer);
      setMounted(false);
    };
  }, [visible, onHide]);

  if (!visible) return null;

  return (
    <div
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 z-[10002]',
        'px-4 py-2 bg-surface-primary/95 backdrop-blur-md',
        'border border-border-primary/60 rounded-lg shadow-dropdown-elevated',
        'text-[13px] text-text-primary pointer-events-none',
        'will-change-[transform,opacity]',
        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
      )}
      style={{
        transition: 'opacity 120ms cubic-bezier(0.16, 1, 0.3, 1), transform 120ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {message}
    </div>
  );
};

InterceptorToast.displayName = 'InterceptorToast';
