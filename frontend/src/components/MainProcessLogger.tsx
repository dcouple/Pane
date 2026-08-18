import { useEffect } from 'react';

export function MainProcessLogger() {
  useEffect(() => {
    // Forward main process logs to browser console
    const unsubscribe = window.electronAPI?.events?.onMainLog?.((level: string, message: string) => {
      const prefix = '[Main Process]';
      switch (level) {
        case 'error':
          console.error(prefix, message);
          break;
        case 'warn':
          console.warn(prefix, message);
          break;
        case 'info':
          // eslint-disable-next-line no-console -- this component intentionally mirrors main-process logs.
          console.info(prefix, message);
          break;
        default:
          // eslint-disable-next-line no-console -- this component intentionally mirrors main-process logs.
          console.log(prefix, message);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  return null;
}
