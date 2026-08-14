import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentUsageSnapshot } from '../../../shared/types/agentUsage';

const REFRESH_INTERVAL_MS = 60_000;

export function useAgentUsage(sessionId: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<AgentUsageSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async (force = false) => {
    if (!enabled || !sessionId) return;
    const generation = ++requestGeneration.current;
    setIsLoading(true);
    setError(null);

    try {
      const response = await window.electronAPI.agentUsage.get(sessionId, force);
      if (generation !== requestGeneration.current) return;
      if (!response.success || !response.data) {
        setError(response.error || 'Codex usage is unavailable');
        return;
      }
      setSnapshot(response.data);
    } catch (requestError) {
      if (generation !== requestGeneration.current) return;
      setError(requestError instanceof Error ? requestError.message : 'Codex usage is unavailable');
    } finally {
      if (generation === requestGeneration.current) setIsLoading(false);
    }
  }, [enabled, sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      requestGeneration.current += 1;
    };
  }, [enabled, refresh, sessionId]);

  return { snapshot, isLoading, error, refresh };
}
