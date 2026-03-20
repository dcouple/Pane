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

import type { CloudVmConfig } from '../../../shared/types/cloud';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';

export interface AppConfig {
  verbose?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  // Legacy fields for backward compatibility
  gitRepoPath?: string;
  systemPromptAppend?: string;
  runScript?: string[];
  // Custom claude executable path (for when it's not in PATH)
  claudeExecutablePath?: string;
  // Permission mode for all sessions
  defaultPermissionMode?: 'approve' | 'ignore';
  // Default model for new sessions
  defaultModel?: string;
  // Auto-check for updates
  autoCheckUpdates?: boolean;
  // Stravu MCP integration
  stravuApiKey?: string;
  stravuServerUrl?: string;
  // Theme preference
  theme?: 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled' | 'forge' | 'ember' | 'aurora' | 'night-owl' | 'night-owl-oled' | 'terracotta';
  // UI scale factor (0.75 to 1.5, default 1.0)
  uiScale?: number;
  // Notification settings
  notifications?: {
    enabled: boolean;
    playSound: boolean;
    notifyOnStatusChange: boolean;
    notifyOnWaiting: boolean;
    notifyOnComplete: boolean;
  };
  // Dev mode for debugging
  devMode?: boolean;
  // Additional paths to add to PATH environment variable
  additionalPaths?: string[];
  // Session creation preferences
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
  // Use interactive mode for Claude CLI (persistent process with stdin instead of spawn-per-message)
  useInteractiveMode?: boolean;
  // PostHog analytics settings
  analytics?: {
    enabled: boolean;
    posthogApiKey?: string;
    posthogHost?: string;
    distinctId?: string; // Random UUID for anonymous user identification
  };
  // User-defined custom commands for the Add Tool picker
  customCommands?: CustomCommand[];
  // Terminal shortcuts — hotkey-triggered clipboard paste snippets
  terminalShortcuts?: TerminalShortcut[];
  // Worktree file sync — files/dirs to copy from main repo into new worktrees
  worktreeFileSync?: WorktreeFileSyncEntry[];
  // Preferred shell for Windows terminals
  preferredShell?: 'auto' | 'gitbash' | 'powershell' | 'pwsh' | 'cmd';
  // Cloud VM settings
  cloud?: CloudVmConfig;
  terminalFontFamily?: string;
  terminalFontSize?: number;
}

export interface UpdateConfigRequest {
  verbose?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  claudeExecutablePath?: string;
  systemPromptAppend?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  defaultModel?: string;
  autoCheckUpdates?: boolean;
  stravuApiKey?: string;
  stravuServerUrl?: string;
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
  additionalPaths?: string[];
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
  disableCommitFooter?: boolean;
  // Disable automatic context tracking after Claude responses
  disableAutoContext?: boolean;
  // Use interactive mode for Claude CLI (persistent process with stdin instead of spawn-per-message)
  useInteractiveMode?: boolean;
  // PostHog analytics settings
  analytics?: {
    enabled: boolean;
    posthogApiKey?: string;
    posthogHost?: string;
    distinctId?: string; // Random UUID for anonymous user identification
  };
  // User-defined custom commands for the Add Tool picker
  customCommands?: CustomCommand[];
  // Terminal shortcuts — hotkey-triggered clipboard paste snippets
  terminalShortcuts?: TerminalShortcut[];
  // Worktree file sync — files/dirs to copy from main repo into new worktrees
  worktreeFileSync?: WorktreeFileSyncEntry[];
  // Preferred shell for Windows terminals
  preferredShell?: 'auto' | 'gitbash' | 'powershell' | 'pwsh' | 'cmd';
  // Cloud VM settings
  cloud?: CloudVmConfig;
  terminalFontFamily?: string;
  terminalFontSize?: number;
}
