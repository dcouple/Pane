import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';

describe('ConfigManager keyboard shortcut overrides', () => {
  let directory = '';
  let previousPaneDir: string | undefined;

  beforeEach(async () => {
    previousPaneDir = process.env.PANE_DIR;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-keybindings-'));
    process.env.PANE_DIR = directory;
  });

  afterEach(async () => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    await fs.rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps absence sparse and deletes an empty reset map', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
    await manager.updateConfig({ keyboardShortcutOverrides: { 'open-settings': 'mod+alt+7' } });
    await manager.updateConfig({ keyboardShortcutOverrides: {} });
    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')))
      .not.toHaveProperty('keyboardShortcutOverrides');

    await manager.updateConfig({ keyboardShortcutOverrides: { 'open-settings': 'mod+alt+7' } });
    const persisted = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    delete persisted.keyboardShortcutOverrides;
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(persisted));
    await manager.reloadFromDisk();
    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
  });

  it('round-trips null, unknown ids, and invalid chords verbatim', async () => {
    const raw = {
      'open-settings': null,
      'future-command': 'mod+alt+8',
      'new-session': 'not-a-chord',
    };
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ keyboardShortcutOverrides: raw }));
    const manager = new ConfigManager();
    await manager.initialize();
    await manager.updateConfig({ verbose: true });
    expect(manager.getConfig().keyboardShortcutOverrides).toEqual(raw);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).keyboardShortcutOverrides)
      .toEqual(raw);
  });

  it('preserves a map whose entries are all unknown or invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = { 'future-command': 'mod+alt+8', 'new-session': 'not-a-chord' };
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ keyboardShortcutOverrides: raw }));
    const manager = new ConfigManager();
    await manager.initialize();
    await manager.updateConfig({ verbose: true });
    expect(manager.getConfig().keyboardShortcutOverrides).toEqual(raw);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).keyboardShortcutOverrides)
      .toEqual(raw);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown keyboard shortcut id: future-command'));
    warn.mockRestore();
  });

  it('drops and diagnoses a non-object override map loaded from disk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
      keyboardShortcutOverrides: 'abc',
    }));
    const manager = new ConfigManager();
    await manager.initialize();

    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('must be an object'));
  });

  it('drops and diagnoses a non-object override map received in an update', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new ConfigManager();
    await manager.initialize();

    const malformedUpdate = JSON.parse('{"keyboardShortcutOverrides":["mod+x"]}');
    await manager.updateConfig(malformedUpdate);

    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')))
      .not.toHaveProperty('keyboardShortcutOverrides');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('must be an object'));
  });

  it('logs a snippet/agent conflict with both owners once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
      terminalShortcuts: [{ id: 'duplicate', label: 'Duplicate', key: '3', text: '', enabled: true }],
    }));
    const manager = new ConfigManager();
    await manager.initialize();
    await manager.reloadFromDisk();
    const messages = warn.mock.calls.map(call => call.join(' ')).filter(message => message.includes('conflict'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('add-tool-terminal-claude');
    expect(messages[0]).toContain('terminal-shortcut-duplicate');
  });
});
