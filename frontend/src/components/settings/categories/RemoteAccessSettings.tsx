import { useState } from 'react';
import { Cloud, ExternalLink, Server } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import type { RemoteAccessSubviewId } from '../../../types/settings';
import type { RemoteAccessController } from '../useRemoteAccessSettings';
import { useCloudStore } from '../../../stores/cloudStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { openCloudSetupTerminal } from '../../../services/cloudSetupTerminal';

interface RemoteAccessSettingsProps {
  controller: RemoteAccessController;
  onOpenSubview: (subview: RemoteAccessSubviewId) => void;
  closeSettings: () => void;
}

export function RemoteAccessSettings({ controller, onOpenSubview, closeSettings }: RemoteAccessSettingsProps) {
  const vmState = useCloudStore((state) => state.vmState);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const remoteStatus = controller.connectionState.status === 'connected'
    ? `Connected to ${controller.connectionState.activeProfileLabel ?? 'remote Pane'}`
    : controller.connectionState.mode === 'remote'
      ? `Remote mode: ${controller.connectionState.status}`
      : 'Using local runtime';

  const openCloudSetup = async () => {
    if (!activeSessionId) {
      setCloudError('Select a pane before opening Cloud setup.');
      return;
    }
    try {
      await openCloudSetupTerminal(activeSessionId);
      closeSettings();
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : 'Failed to open Cloud setup terminal');
    }
  };

  return (
    <SettingsPage title="Remote Access" description="Connect Pane to another machine or manage a hosted cloud workspace.">
      {controller.loading && (
        <p className="text-sm text-text-tertiary" aria-live="polite">Loading Remote Pane status...</p>
      )}
      {controller.error && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error" role="alert">
          <span>{controller.error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void controller.reload()}>Retry</Button>
        </div>
      )}
      <SettingsSection title="Remote Pane">
        <SettingRow
          settingId="remote-pane"
          label={remoteStatus}
          description={controller.connectionState.activeBaseUrl ?? 'Worktrees, terminals, and agent commands can run on a remote host.'}
          align="start"
        >
          <div className="flex max-w-sm flex-wrap justify-end gap-2">
            <Button type="button" size="sm" icon={<Server className="h-4 w-4" />} onClick={() => onOpenSubview('host-setup')}>
              Set Up Host
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => onOpenSubview('connections')}>
              Connections
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenSubview('advanced-host')}>
              Advanced
            </Button>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Cloud workspace">
        <SettingRow
          settingId="cloud-workspace"
          label={vmState?.status === 'not_provisioned' || !vmState ? 'Cloud workspace not configured' : `Cloud workspace: ${vmState.status}`}
          description={cloudError ?? vmState?.error ?? 'Provisioning and recovery run in a Pane terminal; lifecycle controls remain in the Cloud widget.'}
          align="start"
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" icon={<Cloud className="h-4 w-4" />} onClick={openCloudSetup}>
              Open Cloud Setup
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<ExternalLink className="h-4 w-4" />}
              onClick={() => window.electronAPI.openExternal('https://runpane.com/docs/remote-daemon')}
            >
              Docs
            </Button>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
