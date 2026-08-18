import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeneralSettings } from './GeneralSettings';
import { SETTINGS_CATEGORIES, settingDomId } from '../catalog';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { DEFAULT_SETTINGS_PREFERENCES } from '../../../types/settings';

function createPersistence(): SettingsPersistence {
  return {
    config: {},
    isLoading: false,
    configError: null,
    fetchConfig: () => Promise.resolve({}),
    saveConfig: () => Promise.resolve(true),
    saveStates: {},
    reportSaveError: () => undefined,
    preferences: DEFAULT_SETTINGS_PREFERENCES,
    preferencesLoading: false,
    savePreference: () => Promise.resolve(true),
  };
}

describe('GeneralSettings feedback entry', () => {
  it('renders the Send feedback row with the shared setting id', () => {
    const markup = renderToStaticMarkup(
      <GeneralSettings persistence={createPersistence()} onUpdate={vi.fn()} onSendFeedback={vi.fn()} />,
    );

    expect(markup).toContain(`id="${settingDomId('send-feedback')}"`);
    expect(markup).toContain('data-setting-id="send-feedback"');
    expect(markup).toContain('Send feedback');
    expect(markup).toContain('Send Feedback');
    expect(markup).toContain('dcouple/Pane');
  });

  it('wires the row button to the shared opener passed down from App', () => {
    const onSendFeedback = vi.fn();
    const markup = renderToStaticMarkup(
      <GeneralSettings persistence={createPersistence()} onUpdate={vi.fn()} onSendFeedback={onSendFeedback} />,
    );

    // Static markup proves the row and its button exist; clicking it and asserting the
    // dialog opens is covered end to end in tests/feedback-pr-qa.spec.ts, since the
    // renderer suite has no DOM environment to dispatch events in.
    expect(markup).toContain('Send Feedback');
    expect(onSendFeedback).not.toHaveBeenCalled();
  });

  it('registers send-feedback under General so deep links and aliases resolve', () => {
    const general = SETTINGS_CATEGORIES.find((category) => category.id === 'general');
    expect(general?.settingIds).toContain('send-feedback');
    expect(general?.aliases).toContain('feedback');
  });
});
