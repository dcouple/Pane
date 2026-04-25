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
    playSound: boolean;
    enabled: boolean;
  };
  devMode?: boolean;
  // Route PTY spawns through an isolated ptyHost UtilityProcess for crash
  // isolation. Off by default. Requires app restart to take effect.
  usePtyHost?: boolean;
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
  };
  // Pane commit footer setting (enabled by default)
  enableCommitFooter?: boolean;
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
