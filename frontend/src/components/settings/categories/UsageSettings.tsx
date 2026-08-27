import { useCallback, useEffect, useState } from 'react';
import { SettingsPage } from '../SettingRow';
import { API } from '../../../utils/api';
import { ProviderLimitsPanel } from '../../usage/ProviderLimits';
import type { UsageRateLimitSample } from '../../../../../shared/types/usage';

export function UsageSettings() {
  const [limits, setLimits] = useState<UsageRateLimitSample[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await API.usage.getReport({ providers: ['codex'] });
      if (response.success && response.data) {
        setLimits(response.data.rateLimits);
      }
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
        <ProviderLimitsPanel limits={limits} refreshing={refreshing} onRefresh={() => { void load(); }} />
      </div>
    </SettingsPage>
  );
}
