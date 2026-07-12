import { useCallback, useRef, useState } from 'react';

export function useDirtySettingsForms() {
  const [dirty, setDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  const requestTransition = useCallback((action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    pendingActionRef.current = action;
    setConfirmOpen(true);
  }, [dirty]);

  const discardAndContinue = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setDirty(false);
    setConfirmOpen(false);
    action?.();
  }, []);

  const stay = useCallback(() => {
    pendingActionRef.current = null;
    setConfirmOpen(false);
  }, []);

  return {
    dirty,
    setDirty,
    requestTransition,
    confirmOpen,
    discardAndContinue,
    stay,
  };
}
