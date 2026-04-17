import { EventEmitter } from 'events';
import type { AppConfig } from '../types/config';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';
import { DEFAULT_WORKTREE_FILE_SYNC_ENTRIES } from '../../../shared/types/worktreeFileSync';
import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import path from 'path';
import os from 'os';
import { getAppDirectory } from '../utils/appDirectory';
import { clearShellPathCache } from '../utils/shellPath';

export class ConfigManager extends EventEmitter {
  private config: AppConfig;
  private configPath: string;
  private configDir: string;
  private fileWatcher: FSWatcher | null = null;
  private lastConfigJson: string = '';

  constructor(defaultGitPath?: string) {
    super();
    this.configDir = getAppDirectory();
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = {
      gitRepoPath: defaultGitPath || os.homedir(),
      verbose: false,
      anthropicApiKey: undefined,
      systemPromptAppend: undefined,
      runScript: undefined,
      theme: 'light-rounded',
      terminalFontFamily: 'Geist Mono',
      terminalFontSize: 14,
      defaultPermissionMode: 'ignore',
      defaultModel: 'sonnet',
      stravuApiKey: undefined,
      stravuServerUrl: '', // Stravu integration disabled
      notifications: {
        playSound: true,
        enabled: true
      },
      sessionCreationPreferences: {
        sessionCount: 1,
        toolType: 'none',
        selectedTools: {
          claude: false
        },
        claudeConfig: {
          model: 'auto',
          permissionMode: 'ignore',
          ultrathink: false
        },
        showAdvanced: false
      },
      analytics: {
        enabled: false, // Opt-in: disabled by default until user consents
        posthogApiKey: 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1',
        posthogHost: 'https://us.i.posthog.com'
      },
      terminalShortcuts: [
        {
          id: 'default-root-cause',
          label: 'Root cause or symptom?',
          key: 'e',
          text: 'Think hard: is this the root cause or a symptom? How might we solve this at the root?',
          enabled: true
        },
        {
          id: 'default-codex-review',
          label: 'Codex review loop',
          key: 'r',
          text: "Prepare a PR once done with changes, then run in a subagent 'codex review --base main' and wait for it to respond. Read its response and make the fixes it suggests. Continue in a loop until it says there are no longer any issues.",
          enabled: true
        },
        {
          id: 'default-rebase-merge-release',
          label: 'Rebase, merge & release',
          key: 'd',
          text: 'Rebase main and merge the PR to main, then bump a release patch.',
          enabled: true
        },
        {
          id: 'default-review-and-release',
          label: 'Review and release loop',
          key: 's',
          text: "Prepare a PR once done with changes, then run in a subagent 'codex review --base main' and wait for it to respond. Read its response and make the fixes it suggests. Continue in a loop until it says there are no longer any issues. Once there are no issues, rebase main and merge the PR to main, then bump a release patch.",
          enabled: true
        }
      ],
      worktreeFileSync: DEFAULT_WORKTREE_FILE_SYNC_ENTRIES
    };
  }

  async initialize(): Promise<void> {
    // Ensure the config directory exists
    await fs.mkdir(this.configDir, { recursive: true });
    
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const loadedConfig = JSON.parse(data);
      
      // Migrate legacy notification fields from older config files.
      // notifyWhenBackgrounded -> enabled (if enabled is not explicitly set)
      // notifyWhenViewingOtherPanel is dropped silently.
      const incomingNotifications = loadedConfig.notifications as (
        Partial<{ playSound: boolean; enabled: boolean }> &
        { notifyWhenBackgrounded?: boolean; notifyWhenViewingOtherPanel?: boolean }
      ) | undefined;
      const migratedNotifications = incomingNotifications
        ? {
            playSound: incomingNotifications.playSound ?? this.config.notifications!.playSound,
            enabled: incomingNotifications.enabled ?? incomingNotifications.notifyWhenBackgrounded ?? this.config.notifications!.enabled,
          }
        : this.config.notifications!;

      // Merge loaded config with defaults, ensuring nested settings exist
      this.config = {
        ...this.config,
        ...loadedConfig,
        notifications: migratedNotifications,
        sessionCreationPreferences: {
          ...this.config.sessionCreationPreferences,
          ...loadedConfig.sessionCreationPreferences,
          selectedTools: {
            ...this.config.sessionCreationPreferences?.selectedTools,
            ...loadedConfig.sessionCreationPreferences?.selectedTools
          },
          claudeConfig: {
            ...this.config.sessionCreationPreferences?.claudeConfig,
            ...loadedConfig.sessionCreationPreferences?.claudeConfig
          }
        },
        analytics: {
          ...this.config.analytics,
          ...loadedConfig.analytics
        },
        // Use !== undefined to distinguish "user cleared all entries" (empty array → preserve)
        // from "field absent in config file" (→ use defaults)
        worktreeFileSync: loadedConfig.worktreeFileSync !== undefined
          ? loadedConfig.worktreeFileSync
          : DEFAULT_WORKTREE_FILE_SYNC_ENTRIES
      };
    } catch (error: unknown) {
      const isNotFound = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (isNotFound) {
        // Config file doesn't exist — create with defaults
        await this.saveConfig();
      } else {
        // Config exists but is corrupted — log and keep defaults in memory
        // Do NOT overwrite the file (user might want to recover it)
        console.error('[ConfigManager] Failed to parse config file, using defaults:', error);
      }
    }
  }

  private async saveConfig(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    const tmpPath = this.configPath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(this.config, null, 2));
    await fs.rename(tmpPath, this.configPath);
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * Reload config from disk. Use this when external processes (like setup scripts)
   * may have modified the config file.
   */
  async reloadFromDisk(): Promise<AppConfig> {
    await this.initialize();
    console.log('[ConfigManager] Reloaded config from disk');
    return this.config;
  }

  /**
   * Start watching config file for external changes (e.g., from setup scripts).
   * Emits 'config-updated' when the file changes.
   */
  startWatching(): void {
    if (this.fileWatcher) return; // Already watching

    try {
      this.lastConfigJson = JSON.stringify(this.config);

      const handleFileChange = async () => {
        try {
          // Small delay to let the file finish writing
          await new Promise(resolve => setTimeout(resolve, 100));

          const data = await fs.readFile(this.configPath, 'utf-8');

          // Only emit if content actually changed
          if (data !== this.lastConfigJson) {
            this.lastConfigJson = data;
            await this.initialize();
            console.log('[ConfigManager] Config file changed externally, reloaded');
            this.emit('config-updated', this.config);
          }
        } catch (err) {
          console.error('[ConfigManager] Error reloading config after file change:', err);
        }
      };

      const setupWatcher = () => {
        if (this.fileWatcher) {
          this.fileWatcher.close();
        }

        this.fileWatcher = watch(this.configPath, { persistent: false }, async (eventType) => {
          // Handle both 'change' and 'rename' events
          // 'rename' occurs when using atomic writes (tmp + mv pattern)
          if (eventType === 'change' || eventType === 'rename') {
            await handleFileChange();

            // On rename, the watched inode may have changed, so reattach the watcher
            if (eventType === 'rename') {
              console.log('[ConfigManager] Config file renamed/replaced, reattaching watcher');
              // Small delay before reattaching to let filesystem settle
              setTimeout(() => setupWatcher(), 200);
            }
          }
        });
      };

      setupWatcher();
      console.log('[ConfigManager] Watching config file for external changes');
    } catch (err) {
      console.error('[ConfigManager] Failed to start file watcher:', err);
    }
  }

  /**
   * Stop watching config file.
   */
  stopWatching(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
      console.log('[ConfigManager] Stopped watching config file');
    }
  }

  async updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
    this.config = { ...this.config, ...updates };
    await this.saveConfig();

    // Clear PATH cache if additional paths were updated
    if ('additionalPaths' in updates) {
      clearShellPathCache();
      console.log('[ConfigManager] Additional paths updated, cleared PATH cache');
    }
    
    this.emit('config-updated', this.config);
    return this.getConfig();
  }

  getGitRepoPath(): string {
    return this.config.gitRepoPath || '';
  }

  isVerbose(): boolean {
    return this.config.verbose || false;
  }

  getDatabasePath(): string {
    return path.join(this.configDir, 'sessions.db');
  }

  getAnthropicApiKey(): string | undefined {
    return this.config.anthropicApiKey;
  }

  getSystemPromptAppend(): string | undefined {
    return this.config.systemPromptAppend;
  }

  getRunScript(): string[] | undefined {
    return this.config.runScript;
  }

  getStravuApiKey(): string | undefined {
    return this.config.stravuApiKey;
  }

  getStravuServerUrl(): string {
    return this.config.stravuServerUrl || ''; // Stravu integration disabled
  }

  getDefaultModel(): string {
    return this.config.defaultModel || 'sonnet';
  }

  getSessionCreationPreferences() {
    return this.config.sessionCreationPreferences || {
      sessionCount: 1,
      toolType: 'none',
      selectedTools: {
        claude: false
      },
      claudeConfig: {
        model: 'auto',
        permissionMode: 'ignore',
        ultrathink: false
      },
      showAdvanced: false
    };
  }

  getAnalyticsSettings() {
    return this.config.analytics || {
      enabled: false, // Opt-in: disabled by default until user consents
      posthogApiKey: 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1',
      posthogHost: 'https://us.i.posthog.com'
    };
  }

  isAnalyticsEnabled(): boolean {
    return this.config.analytics?.enabled ?? false; // Opt-in: default to false
  }

  getAnalyticsDistinctId(): string | undefined {
    return this.config.analytics?.distinctId;
  }

  async setAnalyticsDistinctId(distinctId: string): Promise<void> {
    if (!this.config.analytics) {
      this.config.analytics = {
        enabled: true,
        posthogApiKey: 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1',
        posthogHost: 'https://us.i.posthog.com'
      };
    }
    this.config.analytics.distinctId = distinctId;
    await this.saveConfig();
  }

  /**
   * Get the user's preferred shell for terminal sessions.
   * Validates the preference against allowed values and returns 'auto' if invalid.
   * @returns One of: 'auto', 'gitbash', 'powershell', 'pwsh', 'cmd'
   */
  getPreferredShell(): string {
    const pref = this.config.preferredShell || 'auto';
    const validPrefs = ['auto', 'gitbash', 'powershell', 'pwsh', 'cmd'];
    return validPrefs.includes(pref) ? pref : 'auto';
  }

  /**
   * Get the configured worktree file sync entries.
   * Returns defaults if no entries are configured.
   */
  getWorktreeFileSyncEntries(): WorktreeFileSyncEntry[] {
    return this.config.worktreeFileSync ?? DEFAULT_WORKTREE_FILE_SYNC_ENTRIES;
  }
}
