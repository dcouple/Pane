import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Bot,
  BrainCircuit,
  GitBranch,
  Keyboard,
  Link2,
  Monitor,
  Settings,
  Shield,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import type { SettingsCategoryId, SettingsSettingId } from '../../types/settings';

export interface SettingsCategoryDefinition {
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
  settingIds: readonly SettingsSettingId[];
  aliases: readonly string[];
  availability?: { disabled: boolean; reason: string };
}

export const SETTINGS_CATEGORIES: readonly SettingsCategoryDefinition[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Startup and application updates.',
    icon: Settings,
    settingIds: ['automatic-updates', 'check-updates-now', 'start-on-login', 'keep-awake'],
    aliases: ['startup', 'updates', 'login', 'sleep', 'caffeinate', 'awake', 'power'],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, scale, and sidebar presentation.',
    icon: Monitor,
    settingIds: ['theme', 'high-contrast', 'ui-scale', 'sidebar-pane-rows'],
    aliases: ['theme', 'display', 'sidebar', 'zoom', 'contrast', 'accessibility'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    description: 'Terminal display, references, shell, and power behavior.',
    icon: Terminal,
    settingIds: ['terminal-font-family', 'terminal-font-size', 'terminal-power-mode', 'terminal-reference-paste-mode', 'terminal-reference-line-count', 'terminal-shell'],
    aliases: ['font', 'shell', 'scrollback', 'gpu', 'battery'],
  },
  {
    id: 'ai-agents',
    label: 'AI & Agents',
    description: 'Agent defaults, context, and CLI installations.',
    icon: Bot,
    settingIds: ['default-pane-chat-agent', 'agent-context', 'claude-executable'],
    aliases: ['claude', 'codex', 'pane chat', 'agents.md'],
  },
  {
    id: 'worktrees-git',
    label: 'Worktrees & Git',
    description: 'Defaults for commits, pull requests, and new worktrees.',
    icon: GitBranch,
    settingIds: ['commit-footer', 'git-attribution', 'auto-rename-pr', 'worktree-file-sync'],
    aliases: ['git', 'worktree', 'commit', 'pull request', 'pr', 'attribution', 'committer', 'author'],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Desktop alerts, permissions, and sound.',
    icon: Bell,
    settingIds: ['notification-permission', 'notification-sound', 'desktop-notifications'],
    aliases: ['alerts', 'sound', 'desktop'],
  },
  {
    id: 'remote-access',
    label: 'Remote Access',
    description: 'Remote Pane hosts, saved connections, and cloud workspaces.',
    icon: Link2,
    settingIds: ['remote-pane', 'remote-host-setup', 'remote-connections', 'remote-advanced-host', 'cloud-workspace'],
    aliases: ['remote pane', 'daemon', 'tailscale', 'cloud vm', 'host'],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Provider credentials and voice transcription.',
    icon: BrainCircuit,
    settingIds: ['voice-transcription'],
    aliases: ['fal', 'openrouter', 'deepgram', 'voice', 'dictation'],
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    description: 'Terminal snippet hotkeys.',
    icon: Keyboard,
    settingIds: ['terminal-shortcuts'],
    aliases: ['hotkeys', 'keyboard', 'snippets'],
  },
  {
    id: 'privacy',
    label: 'Privacy',
    description: 'Analytics and data-sharing choices.',
    icon: Shield,
    settingIds: ['analytics'],
    aliases: ['analytics', 'telemetry', 'tracking'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Diagnostics, terminal backend, and environment paths.',
    icon: SlidersHorizontal,
    settingIds: ['verbose-logging', 'developer-mode', 'pty-host', 'additional-paths'],
    aliases: ['debug', 'verbose', 'developer', 'pty', 'path'],
  },
] as const;

export const SETTINGS_CATEGORY_BY_ID = Object.fromEntries(
  SETTINGS_CATEGORIES.map((category) => [category.id, category]),
) as Record<SettingsCategoryId, SettingsCategoryDefinition>;

export function settingDomId(settingId: SettingsSettingId): string {
  return `settings-${settingId}`;
}
