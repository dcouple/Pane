import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentUsageSnapshot } from '../../../shared/types/agentUsage';

const REFRESH_INTERVAL_MS = 60_000;

export function useAgentUsage() {
  const [snapshot, setSnapshot] = useState<AgentUsageSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async (force = false) => {
    const generation = ++requestGeneration.current;
    setIsLoading(true);
    setError(null);

    try {
      const response = await window.electronAPI.agentUsage.get(force);
      if (generation !== requestGeneration.current) return;
      if (!response.success || !response.data) {
        setSnapshot(null);
        setError(response.error || 'Codex usage is unavailable');
        return;
      }
      setSnapshot(response.data);
    } catch (requestError) {
      if (generation !== requestGeneration.current) return;
      setSnapshot(null);
      setError(requestError instanceof Error ? requestError.message : 'Codex usage is unavailable');
    } finally {
      if (generation === requestGeneration.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      requestGeneration.current += 1;
    };
  }, [refresh]);

  return { snapshot, isLoading, error, refresh };
}
