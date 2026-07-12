import { useEffect, useMemo, useState } from 'react';
import { Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Input, Textarea } from '../../ui/Input';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { TerminalShortcut } from '../../../types/config';
import { formatKeyDisplay } from '../../../utils/hotkeyUtils';

interface ShortcutsSettingsProps {
  persistence: SettingsPersistence;
  onDirtyChange: (dirty: boolean) => void;
}

export function ShortcutsSettings({ persistence, onDirtyChange }: ShortcutsSettingsProps) {
  const config = persistence.config!;
  const persistedShortcuts = config.terminalShortcuts ?? [];
  const persistedKey = JSON.stringify(persistedShortcuts);
  const [shortcuts, setShortcuts] = useState<TerminalShortcut[]>(persistedShortcuts);
  const dirty = JSON.stringify(shortcuts) !== persistedKey;

  useEffect(() => setShortcuts(JSON.parse(persistedKey) as TerminalShortcut[]), [persistedKey]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const shortcut of shortcuts.filter((item) => item.enabled && item.key)) {
      counts.set(shortcut.key, (counts.get(shortcut.key) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
  }, [shortcuts]);
  const invalid = shortcuts.some((shortcut) => !shortcut.label.trim() || !shortcut.key || !shortcut.text.trim()) || duplicateKeys.size > 0;

  const update = (index: number, patch: Partial<TerminalShortcut>) => {
    setShortcuts((current) => current.map((shortcut, shortcutIndex) => (
      shortcutIndex === index ? { ...shortcut, ...patch } : shortcut
    )));
  };

  const apply = async () => {
    if (invalid) return;
    const saved = await persistence.saveConfig('terminal-shortcuts', { terminalShortcuts: shortcuts });
    if (saved) onDirtyChange(false);
  };

  return (
    <SettingsPage title="Shortcuts" description="Bind application-wide Ctrl/Cmd+Alt+letter shortcuts to terminal snippets.">
      <SettingsSection title="Terminal snippets">
        <SettingRow
          settingId="terminal-shortcuts"
          label="Snippet shortcuts"
          description="Each enabled shortcut needs a unique letter, label, and snippet."
          saveState={persistence.saveStates['terminal-shortcuts']}
          align="start"
        >
          <div className="w-full space-y-3 sm:w-[500px]">
            {shortcuts.map((shortcut, index) => (
              <div key={shortcut.id} className="space-y-2 rounded-md border border-border-secondary p-3">
                <div className="grid grid-cols-[minmax(0,1fr)_80px_auto] items-start gap-2">
                  <Input
                    label="Label"
                    value={shortcut.label}
                    onChange={(event) => update(index, { label: event.target.value })}
                    error={!shortcut.label.trim() ? 'Label is required' : undefined}
                    fullWidth
                  />
                  <Input
                    label="Key"
                    value={shortcut.key}
                    onChange={(event) => update(index, { key: event.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 1) })}
                    error={!shortcut.key ? 'Required' : duplicateKeys.has(shortcut.key) ? 'In use' : undefined}
                    fullWidth
                  />
                  <div className="flex gap-1 pt-6">
                    <IconButton
                      type="button"
                      aria-label={shortcut.enabled ? 'Disable shortcut' : 'Enable shortcut'}
                      title={shortcut.enabled ? 'Disable' : 'Enable'}
                      icon={shortcut.enabled ? <Power className="h-4 w-4 text-status-success" /> : <PowerOff className="h-4 w-4" />}
                      onClick={() => update(index, { enabled: !shortcut.enabled })}
                    />
                    <IconButton
                      type="button"
                      aria-label="Delete shortcut"
                      title="Delete"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setShortcuts((current) => current.filter((_, shortcutIndex) => shortcutIndex !== index))}
                    />
                  </div>
                </div>
                <Textarea
                  label="Snippet text"
                  value={shortcut.text}
                  onChange={(event) => update(index, { text: event.target.value })}
                  error={!shortcut.text.trim() ? 'Snippet text is required' : undefined}
                  rows={2}
                  fullWidth
                />
                <p className="text-xs text-text-tertiary">
                  {shortcut.key ? formatKeyDisplay(`mod+alt+${shortcut.key}`) : 'Choose a letter from a-z'}
                </p>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setShortcuts((current) => [...current, {
                  id: crypto.randomUUID(), label: '', key: '', text: '', enabled: true,
                }])}
              >
                Add Shortcut
              </Button>
              <Button type="button" size="sm" disabled={!dirty || invalid} onClick={apply}>Apply</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
