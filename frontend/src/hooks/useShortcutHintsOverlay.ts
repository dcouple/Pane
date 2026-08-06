import { useState, useEffect, useRef, useCallback } from 'react';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../stores/configStore';

const HOLD_DELAY_MS = 300;

export function useShortcutHintsOverlay(): { isVisible: boolean } {
  const keyboardShortcutsEnabled = useConfigStore((state) => areKeyboardShortcutsEnabled(state.config));
  const [isVisible, setIsVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isShowingRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (isShowingRef.current) {
      isShowingRef.current = false;
      setIsVisible(false);
    }
  }, []);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) {
      cancel();
      return;
    }

    const isModifierKey = (key: string) =>
      key === 'Meta' || key === 'Control' || key === 'Alt';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      // Non-modifier key pressed — cancel/dismiss
      if (!isModifierKey(e.key)) {
        cancel();
        return;
      }

      // Both ctrl/cmd AND alt must be held
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (!ctrlOrMeta || !e.altKey) return;

      // Suppress when modal is open
      if (document.querySelector('[aria-modal="true"]')) return;

      // Already showing or timer pending
      if (isShowingRef.current || timerRef.current) return;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        isShowingRef.current = true;
        setIsVisible(true);
      }, HOLD_DELAY_MS);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isModifierKey(e.key)) cancel();
    };

    const handleBlur = () => cancel();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [cancel, keyboardShortcutsEnabled]);

  return { isVisible };
}
