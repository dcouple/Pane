import { Minus, Plus } from 'lucide-react';
import { IconButton } from '../../ui/Button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/Select';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { SegmentedControl } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { AppConfig } from '../../../types/config';

const THEMES: Array<{ id: NonNullable<AppConfig['theme']>; label: string }> = [
  { id: 'light-rounded', label: 'Light (rounded)' },
  { id: 'light', label: 'Light (sharp)' },
  { id: 'forge', label: 'Forge' },
  { id: 'night-owl', label: 'Night Owl' },
  { id: 'night-owl-oled', label: 'Night Owl (OLED)' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'dusk-oled', label: 'Dusk (OLED)' },
  { id: 'ember', label: 'Ember' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'terracotta', label: 'Terracotta' },
  { id: 'dark', label: 'Dark (sharp)' },
  { id: 'oled', label: 'OLED Black (sharp)' },
];

export function AppearanceSettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const scale = config.uiScale ?? 1;

  const saveScale = (value: number) => persistence.saveConfig('ui-scale', { uiScale: value });

  return (
    <SettingsPage title="Appearance" description="Application-wide interface and sidebar presentation.">
      <SettingsSection title="Interface">
        <SettingRow
          settingId="theme"
          label="Theme"
          description="Choose Pane's color and surface treatment."
          saveState={persistence.saveStates.theme}
        >
          <div className="w-full min-w-[220px] sm:w-60">
            <Select
              value={config.theme ?? 'light-rounded'}
              onValueChange={(value) => void persistence.saveConfig('theme', { theme: value as AppConfig['theme'] })}
            >
              <SelectTrigger aria-label="Theme"><SelectValue /></SelectTrigger>
              <SelectContent>
                {THEMES.map((theme) => <SelectItem key={theme.id} value={theme.id}>{theme.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </SettingRow>
        <SettingRow
          settingId="ui-scale"
          label="UI scale"
          description="Adjust all application UI between 0.8x and 1.5x."
          saveState={persistence.saveStates['ui-scale']}
        >
          <div className="flex items-center gap-2">
            <IconButton
              type="button"
              aria-label="Decrease UI scale"
              icon={<Minus className="h-4 w-4" />}
              variant="secondary"
              size="sm"
              disabled={scale <= 0.8}
              onClick={() => void saveScale(Math.max(0.8, Math.round((scale - 0.1) * 10) / 10))}
            />
            <span className="w-12 text-center text-sm font-medium text-text-primary">{scale.toFixed(1)}x</span>
            <IconButton
              type="button"
              aria-label="Increase UI scale"
              icon={<Plus className="h-4 w-4" />}
              variant="secondary"
              size="sm"
              disabled={scale >= 1.5}
              onClick={() => void saveScale(Math.min(1.5, Math.round((scale + 0.1) * 10) / 10))}
            />
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Sidebar">
        <SettingRow
          settingId="sidebar-pane-rows"
          label="Pane row layout"
          description="Choose how pane metadata appears in the left sidebar."
          saveState={persistence.saveStates['sidebar-pane-rows']}
        >
          <SegmentedControl
            label="Sidebar pane row layout"
            value={persistence.preferences.sidebarPaneRowLayout}
            options={[{ id: 'single', label: 'Single row' }, { id: 'two-row', label: 'Two rows' }]}
            onChange={(value) => void persistence.savePreference('sidebarPaneRowLayout', value)}
          />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
