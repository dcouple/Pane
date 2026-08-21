import { useEffect, useState } from 'react';

export interface WindowActivity {
  /** The window is on screen at all (not minimised, not a hidden tab). */
  visible: boolean;
  /** The window has focus, so the user is looking at this app right now. */
  focused: boolean;
}

/**
 * How much attention this window is getting.
 *
 * Two signals, because they mean different things and `document.visibilityState`
 * alone answers neither: a window sitting behind another application stays
 * "visible" (notably on macOS), so a visibility-only guard never fires for the
 * case that costs the most battery. `App.tsx` gates its animations on the same
 * pair.
 */
export function useWindowActive(): WindowActivity {
  const [activity, setActivity] = useState<WindowActivity>(() => ({
    visible: document.visibilityState === 'visible',
    focused: true,
  }));

  useEffect(() => {
    let focused = true;
    let visible = document.visibilityState === 'visible';
    const publish = () => setActivity(current => (
      current.visible === visible && current.focused === focused
        ? current
        : { visible, focused }
    ));

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

  return activity;
}
