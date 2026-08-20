import { useEffect, useState } from 'react';

/**
 * Whether this window is both visible and focused.
 *
 * `document.visibilityState` alone is not enough: a window sitting behind
 * another application stays "visible" (notably on macOS), so anything that
 * polls or streams while merely open keeps costing battery with nobody
 * watching. `App.tsx` gates its animations on the same two signals.
 */
export function useWindowActive(): boolean {
  const [active, setActive] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    let focused = true;
    let visible = document.visibilityState === 'visible';
    const publish = () => setActive(focused && visible);

    const handleVisibility = () => {
      visible = document.visibilityState === 'visible';
      publish();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    void window.electronAPI.window?.isFocused?.()
      .then((isFocused) => {
        focused = isFocused;
        publish();
      })
      .catch(() => {
        // Default to focused when the query is unavailable.
      });

    const unsubscribe = window.electronAPI.events.onWindowFocusChanged((isFocused) => {
      focused = isFocused;
      publish();
    });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      unsubscribe();
    };
  }, []);

  return active;
}
