import { useEffect, useState } from 'react';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { SecretField } from '../SecretField';
import { SegmentedControl } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { VoiceTranscriptionMode } from '../../../../../shared/types/voiceTranscription';

interface IntegrationsSettingsProps {
  persistence: SettingsPersistence;
  onDirtyChange: (dirty: boolean) => void;
}

export function IntegrationsSettings({ persistence, onDirtyChange }: IntegrationsSettingsProps) {
  const config = persistence.config!;
  const persisted = {
    falApiKey: config.falApiKey ?? '',
    openRouterApiKey: config.openRouterApiKey ?? '',
    deepgramApiKey: config.deepgramApiKey ?? '',
    voiceTranscriptionMode: config.voiceTranscriptionMode ?? 'streaming' as VoiceTranscriptionMode,
  };
  const persistedKey = JSON.stringify(persisted);
  const [draft, setDraft] = useState(persisted);
  const dirty = JSON.stringify(draft) !== persistedKey;

  useEffect(() => setDraft(JSON.parse(persistedKey) as typeof persisted), [persistedKey]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const apply = async () => {
    const saved = await persistence.saveConfig('voice-transcription', {
      falApiKey: draft.falApiKey.trim() || undefined,
      openRouterApiKey: draft.openRouterApiKey.trim() || undefined,
      deepgramApiKey: draft.deepgramApiKey.trim() || undefined,
      voiceTranscriptionMode: draft.voiceTranscriptionMode,
    });
    if (saved) onDirtyChange(false);
  };

  return (
    <SettingsPage title="Integrations" description="Provider credentials used by Pane's remote voice dictation pipeline.">
      <SettingsSection title="Voice transcription" description="Credentials stay in Pane's application config and are masked by default.">
        <SettingRow
          settingId="voice-transcription"
          label="Provider credentials"
          description="Fal transcribes recorded audio, OpenRouter cleans transcripts, and Deepgram provides live streaming tokens."
          saveState={persistence.saveStates['voice-transcription']}
          align="start"
        >
          <div className="w-full space-y-3 sm:w-[460px]">
            <SecretField
              label="Fal API key"
              value={draft.falApiKey}
              placeholder="fal_..."
              onChange={(value) => setDraft((current) => ({ ...current, falApiKey: value }))}
              onRemove={() => setDraft((current) => ({ ...current, falApiKey: '' }))}
            />
            <SecretField
              label="OpenRouter API key"
              value={draft.openRouterApiKey}
              placeholder="sk-or-..."
              onChange={(value) => setDraft((current) => ({ ...current, openRouterApiKey: value }))}
              onRemove={() => setDraft((current) => ({ ...current, openRouterApiKey: '' }))}
            />
            <SecretField
              label="Deepgram API key"
              value={draft.deepgramApiKey}
              placeholder="dg_..."
              onChange={(value) => setDraft((current) => ({ ...current, deepgramApiKey: value }))}
              onRemove={() => setDraft((current) => ({ ...current, deepgramApiKey: '' }))}
            />
            <div className="space-y-2">
              <p className="text-xs font-medium text-text-secondary">Default PWA voice mode</p>
              <SegmentedControl<VoiceTranscriptionMode>
                label="Default PWA voice mode"
                value={draft.voiceTranscriptionMode}
                options={[
                  { id: 'streaming', label: 'Live streaming', description: 'Deepgram Nova-3 with realtime text.' },
                  { id: 'recorded', label: 'Batch recorded', description: 'Fal Wizper after recording stops.' },
                ]}
                onChange={(value) => setDraft((current) => ({ ...current, voiceTranscriptionMode: value }))}
              />
            </div>
            <div className="flex justify-end">
              <Button type="button" size="sm" disabled={!dirty} onClick={apply}>Apply Voice Settings</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
