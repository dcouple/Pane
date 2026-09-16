import { useCallback, useEffect, useState } from 'react';
import { SettingsPage } from '../SettingRow';
import { API } from '../../../utils/api';
import { ProviderLimitsPanel } from '../../usage/ProviderLimits';
import type { UsageRateLimitSample } from '../../../../../shared/types/usage';

export function UsageSettings() {
  const [limits, setLimits] = useState<UsageRateLimitSample[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (rescan = false) => {
    setRefreshing(true);
    try {
      if (rescan) {
        const scanned = await API.usage.rescan();
        if (!scanned.success) throw new Error(scanned.error || 'Failed to refresh usage');
        if (scanned.data?.lastError) throw new Error(scanned.data.lastError);
      }
      const response = await API.usage.getReport({ providers: ['codex'] });
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to load usage');
      setLimits(response.data.rateLimits);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to refresh usage');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <SettingsPage
      title="Usage"
      description="Plan and rate limits from Codex transcripts indexed by Pane."
    >
      <div className="px-3 py-2">
        <p className="mb-2 text-xs text-text-muted">Checked at startup and every 4 hours. Refresh to scan transcripts now.</p>
        <ProviderLimitsPanel limits={limits} refreshing={refreshing} onRefresh={() => { void load(true); }} />
        {error && <p role="alert" className="mt-2 text-xs text-status-warning">{error}</p>}
      </div>
    </SettingsPage>
  );
}
