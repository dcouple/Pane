import type { CloudVmConfig } from '../../../shared/types/cloud';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';

export interface TerminalShortcut {
  id: string;
  label: string;
  key: string;
  text: string;
  enabled: boolean;
}

export interface CustomCommand {
  name: string;
  command: string;
}

export interface AppConfig {
  gitRepoPath: string;
  verbose?: boolean;
  anthropicApiKey?: string;
  systemPromptAppend?: string;
  runScript?: string[];
  claudeExecutablePath?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  autoCheckUpdates?: boolean;
  theme?: 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled' | 'forge' | 'ember' | 'aurora' | 'night-owl' | 'night-owl-oled' | 'terracotta';
  uiScale?: number;
  notifications?: {
    enabled: boolean;
    playSound: boolean;
    notifyOnStatusChange: boolean;
    notifyOnWaiting: boolean;
    notifyOnComplete: boolean;
  };
  devMode?: boolean;
  sessionCreationPreferences?: {
    sessionCount?: number;
    toolType?: 'claude' | 'none';
    selectedTools?: {
      claude?: boolean;
    };
    claudeConfig?: {
      model?: 'auto' | 'sonnet' | 'opus' | 'haiku';
      permissionMode?: 'ignore' | 'approve';
      ultrathink?: boolean;
    };
    showAdvanced?: boolean;
    baseBranch?: string;
    commitModeSettings?: {
      mode?: 'checkpoint' | 'incremental' | 'single';
      checkpointPrefix?: string;
    };
  };
  // Pane commit footer setting (enabled by default)
  enableCommitFooter?: boolean;
  // Disable automatic context tracking after Claude responses
  disableAutoContext?: boolean;
  // PostHog analytics settings
  analytics?: {
    enabled: boolean;
    posthogApiKey?: string;
    posthogHost?: string;
  };
  // User-defined custom commands for the Add Tool picker
  customCommands?: CustomCommand[];
  // Terminal shortcuts — hotkey-triggered clipboard paste snippets
  terminalShortcuts?: TerminalShortcut[];
  // Worktree file sync — files/dirs to copy from main repo into new worktrees
  worktreeFileSync?: WorktreeFileSyncEntry[];
  // Preferred shell for terminal sessions on Windows
  preferredShell?: 'auto' | 'gitbash' | 'powershell' | 'pwsh' | 'cmd';
  // Cloud VM settings
  cloud?: CloudVmConfig;
  terminalFontFamily?: string;
  terminalFontSize?: number;
}
