import React, { useEffect } from 'react';

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
  useEffect(() => {
    if (!visible) return;

    const timer = setTimeout(() => {
      onHide();
    }, 2000);

    return () => {
      clearTimeout(timer);
    };
  }, [visible, onHide]);

  if (!visible) return null;

  return (
    <div
      className={[
        'absolute bottom-4 left-1/2 -translate-x-1/2 z-[10002]',
        'px-4 py-2 bg-surface-primary border border-border-primary rounded-lg shadow-dropdown-elevated',
        'text-sm text-text-primary pointer-events-none',
        'opacity-100 transition-opacity duration-200',
      ].join(' ')}
    >
      {message}
    </div>
  );
};

InterceptorToast.displayName = 'InterceptorToast';
