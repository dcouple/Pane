import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { API } from '../../../utils/api';

export function GeneralSettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    setUpdateResult(null);
    try {
      const response = await API.checkForUpdates();
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to check for updates');
      setUpdateResult(response.data.hasUpdate ? 'An update is available.' : 'Pane is up to date.');
    } catch (error) {
      setUpdateResult(error instanceof Error ? error.message : 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsPage title="General" description="Application startup and update behavior.">
      <SettingsSection title="Updates" description="Keep Pane current with release checks from GitHub.">
        <SettingRow
          settingId="automatic-updates"
          label="Check for updates automatically"
          description="Pane checks for a new release every 24 hours. Installation remains manual."
          saveState={persistence.saveStates['automatic-updates']}
        >
          <ImmediateToggle
            label="Check for updates automatically"
            value={config.autoCheckUpdates !== false}
            onSave={(value) => persistence.saveConfig('automatic-updates', { autoCheckUpdates: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="check-updates-now"
          label="Check now"
          description={updateResult ?? 'Request the latest release status now.'}
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="h-4 w-4" />}
            loading={checking}
            loadingText="Checking"
            onClick={checkNow}
          >
            Check Now
          </Button>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Startup" description="Application-wide login behavior.">
        <SettingRow
          settingId="start-on-login"
          label="Start Pane when you log in"
          description="Ask the operating system to open Pane automatically after sign-in."
          saveState={persistence.saveStates['start-on-login']}
        >
          <ImmediateToggle
            label="Start Pane when you log in"
            value={config.autoStartOnBoot !== false}
            onSave={(value) => persistence.saveConfig('start-on-login', { autoStartOnBoot: value })}
          />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
