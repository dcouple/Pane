import type { CloudVmConfig } from '../../../shared/types/cloud';
import type { RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { PaneChatAgent } from '../../../shared/types/paneChat';
import type { VoiceTranscriptionMode } from '../../../shared/types/voiceTranscription';
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

export type TerminalPowerMode = 'performance' | 'batterySaver';

export interface AnalyticsIdentity {
  distinctId: string;
  identitySource: 'email' | 'github' | 'git_name' | 'posthog' | 'anonymous';
  installId?: string;
  appVersion?: string;
  platform?: string;
  electronVersion?: string;
  webDistinctId?: string;
  webAttributionPresent?: boolean;
  isFirstLaunch?: boolean;
  previousVersion?: string | null;
  githubUsername?: string;
  githubEmail?: string;
  gitEmail?: string;
  gitEmailHash?: string;
  gitUserName?: string;
}

export interface AnalyticsConfig {
  enabled: boolean;
  posthogApiKey?: string;
  posthogHost?: string;
  installId?: string;
  distinctId?: string;
  identitySource?: AnalyticsIdentity['identitySource'];
  githubUsername?: string;
  githubEmail?: string;
  gitEmail?: string;
  gitEmailHash?: string;
  gitUserName?: string;
}

export interface AppConfig {
  verbose?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  falApiKey?: string;
  openRouterApiKey?: string;
  deepgramApiKey?: string;
  voiceTranscriptionMode?: VoiceTranscriptionMode;
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
  // Default agent used by the global Pane Chat orchestrator terminal
  defaultOrchestratorAgent?: PaneChatAgent;
  // Auto-check for updates
  autoCheckUpdates?: boolean;
  // Start Pane automatically when the user logs in
  autoStartOnBoot?: boolean;
  // Stravu MCP integration
  stravuApiKey?: string;
  stravuServerUrl?: string;
  // Theme preference
  theme?: 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled' | 'forge' | 'ember' | 'aurora' | 'night-owl' | 'night-owl-oled' | 'terracotta';
  // UI scale factor (0.75 to 1.5, default 1.0)
  uiScale?: number;
  // Notification settings
  notifications?: {
    playSound: boolean;
    enabled: boolean;
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
    startPinned?: boolean;
    baseBranch?: string;
  };
  // Pane commit footer setting (enabled by default)
  enableCommitFooter?: boolean;
  // Agent-facing Pane context in repository instructions files
  agentContext?: {
    managedAgentsMd: boolean;
  };
  // Use interactive mode for Claude CLI (persistent process with stdin instead of spawn-per-message)
  useInteractiveMode?: boolean;
  // Route PTY spawns through an isolated ptyHost UtilityProcess for crash
  // isolation. Off by default. Requires app restart; the supervisor is forked
  // once at `app.whenReady`.
  usePtyHost?: boolean;
  // PostHog analytics settings
  analytics?: AnalyticsConfig;
  // User-defined custom commands for the Add Tool picker
  customCommands?: CustomCommand[];
  // Terminal shortcuts — hotkey-triggered clipboard paste snippets
  terminalShortcuts?: TerminalShortcut[];
  // Worktree file sync — files/dirs to copy from main repo into new worktrees
  worktreeFileSync?: WorktreeFileSyncEntry[];
  // Preferred shell for Windows terminals
  preferredShell?: 'auto' | 'gitbash' | 'powershell' | 'pwsh' | 'cmd';
  // Terminal rendering/power behavior
  terminalPowerMode?: TerminalPowerMode;
  // Cloud VM settings
  cloud?: CloudVmConfig;
  // Self-hosted remote daemon settings and saved client profiles
  remoteDaemon?: RemoteDaemonConfig;
  terminalFontFamily?: string;
  terminalFontSize?: number;
}

export type PreferredShell = NonNullable<AppConfig['preferredShell']>;
export type PreferredTerminalPowerMode = NonNullable<AppConfig['terminalPowerMode']>;

export interface UpdateConfigRequest {
  verbose?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  falApiKey?: string;
  openRouterApiKey?: string;
  deepgramApiKey?: string;
  voiceTranscriptionMode?: VoiceTranscriptionMode;
  claudeExecutablePath?: string;
  systemPromptAppend?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  defaultModel?: string;
  defaultOrchestratorAgent?: PaneChatAgent;
  autoCheckUpdates?: boolean;
  autoStartOnBoot?: boolean;
  stravuApiKey?: string;
  stravuServerUrl?: string;
  theme?: AppConfig['theme'];
  uiScale?: number;
  notifications?: AppConfig['notifications'];
  devMode?: boolean;
  additionalPaths?: string[];
  sessionCreationPreferences?: AppConfig['sessionCreationPreferences'];
  enableCommitFooter?: boolean;
  agentContext?: AppConfig['agentContext'];
  useInteractiveMode?: boolean;
  usePtyHost?: boolean;
  analytics?: AnalyticsConfig;
  customCommands?: CustomCommand[];
  terminalShortcuts?: TerminalShortcut[];
  worktreeFileSync?: WorktreeFileSyncEntry[];
  preferredShell?: PreferredShell;
  terminalPowerMode?: PreferredTerminalPowerMode;
  cloud?: CloudVmConfig;
  terminalFontFamily?: string;
  terminalFontSize?: number;
}
