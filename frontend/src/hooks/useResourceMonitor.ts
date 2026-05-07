import { useState, useEffect, useCallback } from 'react';
import type { ResourceSnapshot } from '../../../shared/types/resourceMonitor';

interface IPCResponse {
  success: boolean;
  data?: ResourceSnapshot;
  error?: string;
}

export function useResourceMonitor() {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Listen for push updates from main process
  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<ResourceSnapshot>;
      setSnapshot(customEvent.detail);
      setIsLoading(false);
    };
    window.addEventListener('resource-monitor:update', handler);

    return () => {
      window.removeEventListener('resource-monitor:update', handler);
      // Stop active polling if component unmounts while popover is open
      window.electronAPI?.resourceMonitor?.stopActive?.();
    };
  }, []);

  const startActive = useCallback(() => {
    window.electronAPI?.resourceMonitor?.startActive?.();
  }, []);

  const stopActive = useCallback(() => {
    window.electronAPI?.resourceMonitor?.stopActive?.();
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const response: IPCResponse | undefined = await window.electronAPI?.resourceMonitor?.getSnapshot?.();
      if (response?.success && response.data) {
        setSnapshot(response.data);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { snapshot, isLoading, startActive, stopActive, refresh };
}
