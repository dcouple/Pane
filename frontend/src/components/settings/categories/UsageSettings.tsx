import { SettingsPage } from '../SettingRow';
import { AgentUsageWidget } from '../../AgentUsageWidget';

export function UsageSettings() {
  return (
    <SettingsPage
      title="Usage"
      description="Plan and rate limits for the Codex login detected on the machine running Pane."
    >
      <AgentUsageWidget />
    </SettingsPage>
  );
}
