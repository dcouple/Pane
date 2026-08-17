// Performance utilities for Pane

/**
 * Checks if the document is visible (not minimized or in background tab)
 */
const isDocumentVisible = () => {
  return document.visibilityState === 'visible';
};

/**
 * Reduces animation frame rate when document is not visible
 */
export const createVisibilityAwareInterval = (
  callback: () => void,
  activeInterval: number,
  inactiveInterval?: number
): (() => void) => {
  let intervalId: NodeJS.Timeout | null = null;

  const updateInterval = () => {
    if (intervalId) {
      clearInterval(intervalId);
    }

    const interval = isDocumentVisible() ? activeInterval : (inactiveInterval || activeInterval * 10);
    intervalId = setInterval(callback, interval);
  };

  // Initial setup
  updateInterval();

  // Listen for visibility changes
  const handleVisibilityChange = () => updateInterval();
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Return cleanup function
  return () => {
    if (intervalId) {
      clearInterval(intervalId);
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
};
