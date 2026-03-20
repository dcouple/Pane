import { useState, useEffect, useCallback } from 'react';
import { NotificationSettings } from './NotificationSettings';
import { useNotifications } from '../hooks/useNotifications';
import { API } from '../utils/api';
import { optIn, capture, captureAndOptOut } from '../services/posthog';
import type { AppConfig, TerminalShortcut } from '../types/config';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';
import { DEFAULT_WORKTREE_FILE_SYNC_ENTRIES } from '../../../shared/types/worktreeFileSync';
import { useConfigStore } from '../stores/configStore';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { useSessionStore } from '../stores/sessionStore';
import { panelApi } from '../services/panelApi';
import {
  Shield,
  ShieldOff,
  Settings as SettingsIcon,
  Palette,
  Zap,
  RefreshCw,
  FileText,
  Eye,
  BarChart3,
  Activity,
  ChevronUp,
  ChevronDown,
  Terminal,
  Cloud,
  Trash2,
  Copy,
  Check,
  Keyboard,
  Plus,
  Power,
  PowerOff,
  Loader2,
  Play,
  FolderSync
} from 'lucide-react';
import { Input, Textarea, Checkbox } from './ui/Input';
import { Button } from './ui/Button';
import { useTheme } from '../contexts/ThemeContext';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { CollapsibleCard } from './ui/CollapsibleCard';
import { SettingsSection } from './ui/SettingsSection';
import { Dropdown } from './ui/Dropdown';

interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  initialSection?: string;
}

export function Settings({ isOpen, onClose, initialSection }: SettingsProps) {
  const [_config, setConfig] = useState<AppConfig | null>(null);
  const [verbose, setVerbose] = useState(false);
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [globalSystemPrompt, setGlobalSystemPrompt] = useState('');
  const [claudeExecutablePath, setClaudeExecutablePath] = useState('');
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<'approve' | 'ignore'>('ignore');
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [devMode, setDevMode] = useState(false);
  const [additionalPathsText, setAdditionalPathsText] = useState('');
  const [platform, setPlatform] = useState<string>('darwin');
  const [enableCommitFooter, setEnableCommitFooter] = useState(true);
  const [disableAutoContext, setDisableAutoContext] = useState(false);
  const [autoRenameToPR, setAutoRenameToPR] = useState<boolean>(true);
  const [uiScale, setUiScale] = useState(1.0);
  const [terminalFontFamily, setTerminalFontFamily] = useState('');
  const [terminalFontSize, setTerminalFontSize] = useState(14);
  const [systemMonoFonts, setSystemMonoFonts] = useState<string[]>([]);
  const [fontSearch, setFontSearch] = useState('');
  const [isFontDropdownOpen, setIsFontDropdownOpen] = useState(false);
  const [notificationSettings, setNotificationSettings] = useState({
    enabled: true,
    playSound: true,
    notifyOnStatusChange: true,
    notifyOnWaiting: true,
    notifyOnComplete: true
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'notifications' | 'shortcuts' | 'analytics'>('general');
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);
  const [previousAnalyticsEnabled, setPreviousAnalyticsEnabled] = useState(true);
  const [preferredShell, setPreferredShell] = useState<string>('auto');
  const [availableShells, setAvailableShells] = useState<Array<{id: string; name: string; path: string}>>([]);
  const [cloudProvider] = useState<'gcp'>('gcp');
  const [cloudApiToken, setCloudApiToken] = useState('');
  const [cloudServerId, setCloudServerId] = useState('');
  const [cloudVncPassword, setCloudVncPassword] = useState('');
  const [vncPasswordCopied, setVncPasswordCopied] = useState(false);
  const [cloudRegion, setCloudRegion] = useState('');
  const [cloudGcpProjectId, setCloudGcpProjectId] = useState('');
  const [cloudGcpZone, setCloudGcpZone] = useState('');
  const [cloudTunnelPort, setCloudTunnelPort] = useState('8080');
  const [terminalShortcuts, setTerminalShortcuts] = useState<TerminalShortcut[]>([]);
  const [worktreeFileSync, setWorktreeFileSync] = useState<WorktreeFileSyncEntry[]>([]);
  const [cloudSetupLoading, setCloudSetupLoading] = useState(false);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const { updateSettings } = useNotifications();
  const { theme, setTheme } = useTheme();
  const { fetchConfig: refreshConfigStore } = useConfigStore();

  const handleRunCloudSetup = useCallback(async () => {
    if (!activeSessionId) return;
    setCloudSetupLoading(true);
    try {
      const panel = await panelApi.createPanel({
        sessionId: activeSessionId,
        type: 'terminal',
        title: 'Cloud Setup',
        initialState: {
          customState: {
            initialCommand: 'bash cloud/scripts/setup-cloud.sh'
          }
        }
      });
      await panelApi.setActivePanel(activeSessionId, panel.id);
      onClose();
    } catch (err) {
      console.error('[Settings] Failed to create cloud setup terminal:', err);
    } finally {
      setCloudSetupLoading(false);
    }
  }, [activeSessionId, onClose]);

  useEffect(() => {
    if (isOpen) {
      // Get platform first, then fetch config (needed for Windows shell detection)
      window.electronAPI.getPlatform().then((p) => {
        setPlatform(p);
        fetchConfig(p);
      });

      // Load system monospace fonts for the font picker
      window.electronAPI.config.getMonospaceFonts().then((result) => {
        if (result?.data && Array.isArray(result.data)) {
          setSystemMonoFonts(result.data as string[]);
        }
      }).catch(() => { /* fc-list not available — dropdown will be empty */ });

      const loadAutoRename = async () => {
        try {
          const result = await window.electron?.invoke('preferences:get', 'auto_rename_sessions_to_pr') as IPCResponse<string>;
          if (result?.data !== undefined && result?.data !== null) {
            setAutoRenameToPR(result.data !== 'false');
          }
        } catch (error) {
          console.error('Failed to load auto-rename preference:', error);
        }
      };
      loadAutoRename();

      // Navigate to shortcuts tab when opened via Ctrl+Alt+/
      if (initialSection === 'terminal-shortcuts') {
        setActiveTab('shortcuts');
      }
    }
  }, [isOpen, initialSection]);

  const fetchConfig = async (currentPlatform?: string) => {
    try {
      const response = await API.config.get();
      if (!response.success) throw new Error(response.error || 'Failed to fetch config');
      const data = response.data;
      setConfig(data);
      setVerbose(data.verbose || false);
      setAnthropicApiKey(data.anthropicApiKey || '');
      setGlobalSystemPrompt(data.systemPromptAppend || '');
      setClaudeExecutablePath(data.claudeExecutablePath || '');
      setDefaultPermissionMode(data.defaultPermissionMode || 'ignore');
      setAutoCheckUpdates(data.autoCheckUpdates !== false); // Default to true
      setDevMode(data.devMode || false);
      setEnableCommitFooter(data.enableCommitFooter !== false); // Default to true
      setDisableAutoContext(data.disableAutoContext || false);
      setUiScale(data.uiScale || 1.0);
      setTerminalFontFamily(data.terminalFontFamily || '');
      setTerminalFontSize(data.terminalFontSize || 14);

      // Load additional paths
      const paths = data.additionalPaths || [];
      setAdditionalPathsText(paths.join('\n'));

      // Load notification settings
      if (data.notifications) {
        setNotificationSettings(data.notifications);
        // Update the useNotifications hook with loaded settings
        updateSettings(data.notifications);
      }

      // Load analytics settings
      if (data.analytics) {
        const enabled = data.analytics.enabled !== false; // Default to true
        setAnalyticsEnabled(enabled);
        setPreviousAnalyticsEnabled(enabled);
      }

      // Fetch available shells on Windows
      const platformToCheck = currentPlatform || platform;
      if (platformToCheck === 'win32') {
        const shellsResponse = await API.config.getAvailableShells();
        if (shellsResponse.success) {
          setAvailableShells(shellsResponse.data);
        }
      }
      setPreferredShell(data.preferredShell || 'auto');

      // Load terminal shortcuts
      setTerminalShortcuts(data.terminalShortcuts ?? []);

      // Load worktree file sync entries
      setWorktreeFileSync(data.worktreeFileSync ?? DEFAULT_WORKTREE_FILE_SYNC_ENTRIES);

      // Load cloud settings
      if (data.cloud) {
        // Provider is always GCP (IAP-secured)
        setCloudApiToken(data.cloud.apiToken || '');
        setCloudServerId(data.cloud.serverId || '');
        setCloudVncPassword(data.cloud.vncPassword || '');
        setCloudRegion(data.cloud.region || '');
        setCloudGcpProjectId(data.cloud.projectId || '');
        setCloudGcpZone(data.cloud.zone || '');
        setCloudTunnelPort(String(data.cloud.tunnelPort || 8080));
      }
    } catch (err) {
      setError('Failed to load configuration');
    }
  };

  const handleAutoRenameToggle = async (checked: boolean) => {
    setAutoRenameToPR(checked);
    try {
      await window.electron?.invoke('preferences:set', 'auto_rename_sessions_to_pr', checked ? 'true' : 'false');
    } catch (error) {
      console.error('Failed to save auto-rename preference:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      // Parse the additional paths text into an array
      const parsedPaths = additionalPathsText
        .split('\n')
        .map(p => p.trim())
        .filter(p => p.length > 0);
      
      const filteredWorktreeFileSync = worktreeFileSync.filter(entry => entry.path.trim().length > 0);

      const response = await API.config.update({
        verbose,
        anthropicApiKey,
        systemPromptAppend: globalSystemPrompt,
        claudeExecutablePath,
        defaultPermissionMode,
        autoCheckUpdates,
        devMode,
        enableCommitFooter,
        disableAutoContext,
        uiScale,
        additionalPaths: parsedPaths,
        notifications: notificationSettings,
        analytics: {
          enabled: analyticsEnabled
        },
        preferredShell,
        terminalShortcuts,
        worktreeFileSync: filteredWorktreeFileSync,
        cloud: (cloudServerId || cloudGcpProjectId || cloudApiToken) ? {
          provider: cloudProvider,
          apiToken: cloudApiToken,
          serverId: cloudServerId || undefined,
          vncPassword: cloudVncPassword || undefined,
          region: cloudRegion || undefined,
          projectId: cloudGcpProjectId || undefined,
          zone: cloudGcpZone || undefined,
          tunnelPort: parseInt(cloudTunnelPort, 10) || 8080,
        } : undefined,
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to update configuration');
      }

      // Only toggle PostHog opt-in/opt-out after config save succeeds
      if (previousAnalyticsEnabled !== analyticsEnabled) {
        if (analyticsEnabled) {
          optIn();
          capture('analytics_opted_in');
        } else {
          captureAndOptOut('analytics_opted_out');
        }
      }

      // Update the useNotifications hook with new settings
      updateSettings(notificationSettings);

      // Refresh config from server
      await fetchConfig();

      // Also refresh the global config store
      await refreshConfigStore();

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update configuration');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" showCloseButton={false}>
      <ModalHeader
        title="Pane Settings"
        icon={<SettingsIcon className="w-5 h-5" />}
        onClose={onClose}
      />

      <ModalBody>
        {/* Tabs */}
        <div className="flex border-b border-border-primary mb-8">
          <button
            onClick={() => setActiveTab('general')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'general'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab('notifications')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'notifications'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Notifications
          </button>
          <button
            onClick={() => setActiveTab('shortcuts')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'shortcuts'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Shortcuts
          </button>
          <button
            onClick={() => setActiveTab('analytics')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'analytics'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Analytics
          </button>
        </div>

        {activeTab === 'general' && (
          <form id="settings-form" onSubmit={handleSubmit} className="space-y-6">
            {/* Appearance */}
            <CollapsibleCard
              title="Appearance & Theme"
              subtitle="Customize how Pane looks and feels"
              icon={<Palette className="w-5 h-5" />}
              defaultExpanded={true}
            >
              <SettingsSection
                title="Theme"
                description="Choose your preferred theme"
                icon={<Palette className="w-4 h-4" />}
              >
                <Dropdown
                  trigger={
                    <button
                      type="button"
                      className="w-full px-4 py-3 bg-surface-secondary hover:bg-surface-hover rounded-lg transition-colors border border-border-secondary text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive cursor-pointer flex items-center justify-between"
                    >
                      <span>{{ light: 'Light (sharp)', 'light-rounded': 'Light (rounded)', dark: 'Dark (sharp)', oled: 'OLED Black (sharp)', dusk: 'Dusk', 'dusk-oled': 'Dusk (OLED)', forge: 'Forge', ember: 'Ember', aurora: 'Aurora', 'night-owl': 'Night Owl', 'night-owl-oled': 'Night Owl (OLED)', terracotta: 'Terracotta' }[theme]}</span>
                      <ChevronDown className="w-4 h-4 text-text-tertiary" />
                    </button>
                  }
                  items={[
                    { id: 'light-rounded', label: 'Light (rounded)', onClick: () => setTheme('light-rounded') },
                    { id: 'forge', label: 'Forge', onClick: () => setTheme('forge') },
                    { id: 'night-owl', label: 'Night Owl', onClick: () => setTheme('night-owl') },
                    { id: 'night-owl-oled', label: 'Night Owl (OLED)', onClick: () => setTheme('night-owl-oled') },
                    { id: 'dusk-oled', label: 'Dusk (OLED)', onClick: () => setTheme('dusk-oled') },
                    { id: 'dusk', label: 'Dusk', onClick: () => setTheme('dusk') },
                    { id: 'ember', label: 'Ember', onClick: () => setTheme('ember') },
                    { id: 'aurora', label: 'Aurora', onClick: () => setTheme('aurora') },
                    { id: 'terracotta', label: 'Terracotta', onClick: () => setTheme('terracotta') },
                    { id: 'light', label: 'Light (sharp)', onClick: () => setTheme('light') },
                    { id: 'dark', label: 'Dark (sharp)', onClick: () => setTheme('dark') },
                    { id: 'oled', label: 'OLED Black (sharp)', onClick: () => setTheme('oled') },
                  ]}
                  selectedId={theme}
                  position="bottom-left"
                  width="full"
                />
              </SettingsSection>

              <SettingsSection
                title="UI Scale"
                description="Adjust the size of all UI elements for better readability"
                icon={<Eye className="w-4 h-4" />}
              >
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        const newScale = Math.round((uiScale - 0.1) * 10) / 10;
                        if (newScale >= 0.8) {
                          setUiScale(newScale);
                          API.config.update({ uiScale: newScale });
                        }
                      }}
                      disabled={uiScale <= 0.8}
                      className="p-1.5 rounded-md bg-surface-tertiary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <span className="text-sm font-medium text-text-primary w-12 text-center">
                      {uiScale.toFixed(1)}x
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const newScale = Math.round((uiScale + 0.1) * 10) / 10;
                        if (newScale <= 1.5) {
                          setUiScale(newScale);
                          API.config.update({ uiScale: newScale });
                        }
                      }}
                      disabled={uiScale >= 1.5}
                      className="p-1.5 rounded-md bg-surface-tertiary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex gap-2">
                    {[0.8, 1.0, 1.2, 1.5].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          setUiScale(preset);
                          API.config.update({ uiScale: preset });
                        }}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                          uiScale === preset
                            ? 'bg-interactive text-white border-interactive'
                            : 'bg-surface-secondary text-text-secondary border-border-secondary hover:bg-surface-hover'
                        }`}
                      >
                        {preset.toFixed(1)}x
                      </button>
                    ))}
                  </div>
                </div>
              </SettingsSection>

              <SettingsSection
                title="Terminal Font"
                description="Customize the font used in terminal panels"
                icon={<Terminal className="w-4 h-4" />}
              >
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                      Font Family
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={isFontDropdownOpen ? fontSearch : (terminalFontFamily || 'Geist Mono')}
                        onChange={(e) => {
                          setFontSearch(e.target.value);
                          if (!isFontDropdownOpen) setIsFontDropdownOpen(true);
                        }}
                        onFocus={() => {
                          setFontSearch('');
                          setIsFontDropdownOpen(true);
                        }}
                        onBlur={() => {
                          // Delay to allow click on dropdown item
                          setTimeout(() => {
                            setIsFontDropdownOpen(false);
                            setFontSearch('');
                          }, 150);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && fontSearch.trim()) {
                            setTerminalFontFamily(fontSearch.trim());
                            setIsFontDropdownOpen(false);
                            API.config.update({ terminalFontFamily: fontSearch.trim() });
                            setFontSearch('');
                          }
                        }}
                        placeholder="Search fonts..."
                        className="w-full px-3 py-2 border border-border-primary rounded-md focus:outline-none focus:ring-2 focus:ring-interactive text-text-primary bg-surface-secondary text-sm"
                      />
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
                      {isFontDropdownOpen && (
                        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-border-primary bg-surface-secondary shadow-lg">
                          {systemMonoFonts.length > 0 ? (
                            <>
                              {systemMonoFonts
                                .filter(f => !fontSearch || f.toLowerCase().includes(fontSearch.toLowerCase()))
                                .map((font) => (
                                  <button
                                    key={font}
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      setTerminalFontFamily(font);
                                      setIsFontDropdownOpen(false);
                                      setFontSearch('');
                                      API.config.update({ terminalFontFamily: font });
                                    }}
                                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface-hover transition-colors ${
                                      font === (terminalFontFamily || 'Geist Mono') ? 'text-interactive font-medium' : 'text-text-primary'
                                    }`}
                                  >
                                    {font}
                                  </button>
                                ))}
                              {fontSearch && systemMonoFonts.filter(f => f.toLowerCase().includes(fontSearch.toLowerCase())).length === 0 && (
                                <div className="px-3 py-2 text-xs text-text-tertiary">No matches — press Enter to use &quot;{fontSearch}&quot;</div>
                              )}
                            </>
                          ) : (
                            <div className="px-3 py-2 text-xs text-text-tertiary">
                              {fontSearch ? <>Press Enter to use &quot;{fontSearch}&quot;</> : 'Type a font name'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-text-tertiary mt-1.5">
                      {systemMonoFonts.length > 0
                        ? 'Select a monospace font or type a custom name. Nerd Font icons are always available.'
                        : 'Type any monospace font installed on your system. Nerd Font icons are always available.'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                      Font Size
                    </label>
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            const newSize = terminalFontSize - 1;
                            if (newSize >= 10) {
                              setTerminalFontSize(newSize);
                              API.config.update({ terminalFontSize: newSize });
                            }
                          }}
                          disabled={terminalFontSize <= 10}
                          className="p-1.5 rounded-md bg-surface-tertiary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                        <span className="text-sm font-medium text-text-primary w-12 text-center">
                          {terminalFontSize}px
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const newSize = terminalFontSize + 1;
                            if (newSize <= 24) {
                              setTerminalFontSize(newSize);
                              API.config.update({ terminalFontSize: newSize });
                            }
                          }}
                          disabled={terminalFontSize >= 24}
                          className="p-1.5 rounded-md bg-surface-tertiary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="flex gap-2">
                        {[12, 14, 16, 18].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => {
                              setTerminalFontSize(preset);
                              API.config.update({ terminalFontSize: preset });
                            }}
                            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                              terminalFontSize === preset
                                ? 'bg-interactive text-white border-interactive'
                                : 'bg-surface-secondary text-text-secondary border-border-secondary hover:bg-surface-hover'
                            }`}
                          >
                            {preset}px
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </SettingsSection>
            </CollapsibleCard>

            {/* AI Integration */}
            <CollapsibleCard
              title="AI Integration"
              subtitle="Configure Claude integration and smart features"
              icon={<Zap className="w-5 h-5" />}
              defaultExpanded={true}
            >
              <SettingsSection
                title="Smart Pane Names"
                description="Let Claude automatically generate meaningful names for your panes"
                icon={<FileText className="w-4 h-4" />}
              >
                <Input
                  label="Anthropic API Key"
                  type="password"
                  value={anthropicApiKey}
                  onChange={(e) => setAnthropicApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  fullWidth
                  helperText="Optional: Used only for generating pane names. Your main Claude Code API key is separate."
                />
              </SettingsSection>

              <SettingsSection
                title="Default Security Mode"
                description="How Claude should handle potentially risky operations"
                icon={defaultPermissionMode === 'approve' ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
              >
                <div className="space-y-3">
                  <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg hover:bg-surface-hover transition-colors border border-border-secondary">
                    <input
                      type="radio"
                      name="defaultPermissionMode"
                      value="ignore"
                      checked={defaultPermissionMode === 'ignore'}
                      onChange={(e) => setDefaultPermissionMode(e.target.value as 'ignore' | 'approve')}
                      className="text-interactive mt-1"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <ShieldOff className="w-4 h-4 text-text-tertiary" />
                        <span className="text-sm font-medium text-text-primary">Fast & Flexible</span>
                        <span className="ml-auto px-2 py-0.5 text-xs bg-status-warning/20 text-status-warning rounded-full">Default</span>
                      </div>
                      <p className="text-xs text-text-tertiary leading-relaxed">
                        Claude executes commands quickly without asking permission. Great for development workflows.
                      </p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg hover:bg-surface-hover transition-colors border border-border-secondary">
                    <input
                      type="radio"
                      name="defaultPermissionMode"
                      value="approve"
                      checked={defaultPermissionMode === 'approve'}
                      onChange={(e) => setDefaultPermissionMode(e.target.value as 'ignore' | 'approve')}
                      className="text-interactive mt-1"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Shield className="w-4 h-4 text-status-success" />
                        <span className="text-sm font-medium text-text-primary">Secure & Controlled</span>
                      </div>
                      <p className="text-xs text-text-tertiary leading-relaxed">
                        Claude asks for your approval before running potentially risky commands. Safer for production code.
                      </p>
                    </div>
                  </label>
                </div>
              </SettingsSection>

              <SettingsSection
                title="Global Instructions"
                description="Add custom instructions that apply to all your projects"
                icon={<FileText className="w-4 h-4" />}
              >
                <Textarea
                  label="Global System Prompt"
                  value={globalSystemPrompt}
                  onChange={(e) => setGlobalSystemPrompt(e.target.value)}
                  placeholder="Always use TypeScript... Follow our team's coding standards..."
                  rows={3}
                  fullWidth
                  helperText="These instructions will be added to every Claude session across all projects."
                />
              </SettingsSection>

              <SettingsSection
                title="Pane Attribution"
                description="Add Pane branding to commit messages"
                icon={<FileText className="w-4 h-4" />}
              >
                <Checkbox
                  label="Include Pane footer in commits"
                  checked={enableCommitFooter}
                  onChange={(e) => setEnableCommitFooter(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  When enabled, commits made through Pane will include a footer crediting Pane. This helps others know you're using Pane for AI-powered development.
                </p>
              </SettingsSection>

              <SettingsSection
                title="Auto-rename Sessions to PR Title"
                description="Automatically rename sessions when a pull request is detected"
                icon={<FileText className="w-4 h-4" />}
              >
                <Checkbox
                  label="Auto-rename sessions to PR title"
                  checked={autoRenameToPR}
                  onChange={(e) => handleAutoRenameToggle(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  When a PR is detected for a session, automatically rename it to the PR title.
                </p>
              </SettingsSection>

              <SettingsSection
                title="Automatic Context Tracking"
                description="Control whether Claude automatically runs /context after responses"
                icon={<Activity className="w-4 h-4" />}
              >
                <Checkbox
                  label="Disable automatic context tracking"
                  checked={disableAutoContext}
                  onChange={(e) => setDisableAutoContext(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  When checked, Pane will not automatically run /context after each
                  Claude response. This reduces wait time and Claude quota usage.
                  You can still manually run /context when needed.
                </p>
              </SettingsSection>
            </CollapsibleCard>

            {/* Worktree File Sync */}
            <CollapsibleCard
              title="Worktree File Sync"
              subtitle="Auto-copy files into new worktrees"
              icon={<FolderSync className="w-5 h-5" />}
              defaultExpanded={false}
            >
              <SettingsSection
                title="Files & Directories"
                description="Copy these from your main repo into new worktrees. Only items that exist but are missing from the worktree (e.g. gitignored) are copied."
              >
                <div className="space-y-2">
                  {worktreeFileSync.map((entry, index) => (
                    <div key={entry.id} className="flex items-center gap-3 p-2 rounded-lg bg-surface-secondary border border-border-secondary">
                      <div className="flex-1 min-w-0">
                        {entry.path ? (
                          <span className="text-sm font-mono">{entry.path}</span>
                        ) : (
                          <Input
                            value={entry.path}
                            onChange={(e) => {
                              const updated = [...worktreeFileSync];
                              updated[index] = { ...entry, path: e.target.value };
                              setWorktreeFileSync(updated);
                            }}
                            placeholder="e.g. .myconfig"
                            className="text-sm"
                            error="Path is required"
                          />
                        )}
                        {entry.recursive && (
                          <span className="ml-2 text-xs text-text-tertiary">includes subdirectories</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...worktreeFileSync];
                          updated[index] = { ...entry, enabled: !entry.enabled };
                          setWorktreeFileSync(updated);
                        }}
                        className={`p-1.5 rounded transition-colors ${
                          entry.enabled
                            ? 'text-status-success hover:text-status-success/80'
                            : 'text-text-tertiary hover:text-text-secondary'
                        }`}
                        title={entry.enabled ? 'Disable' : 'Enable'}
                      >
                        {entry.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setWorktreeFileSync(worktreeFileSync.filter((_, i) => i !== index));
                        }}
                        className="p-1.5 rounded text-text-tertiary hover:text-status-error hover:bg-status-error/10 transition-colors"
                        title="Remove"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>

                {worktreeFileSync.length === 0 && (
                  <p className="text-sm text-text-tertiary italic">No file sync entries configured.</p>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setWorktreeFileSync([
                        ...worktreeFileSync,
                        {
                          id: crypto.randomUUID(),
                          path: '',
                          enabled: true,
                          recursive: false,
                        },
                      ]);
                    }}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Entry
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setWorktreeFileSync(DEFAULT_WORKTREE_FILE_SYNC_ENTRIES)}
                  >
                    Reset to Defaults
                  </Button>
                </div>

                <p className="text-xs text-text-tertiary">
                  Uses fast copy (hard links on Linux, APFS clones on macOS) when possible.
                  Package manager install runs automatically in the background terminal.
                </p>
              </SettingsSection>
            </CollapsibleCard>

            {/* Cloud VM */}
            <CollapsibleCard
              title="Cloud VM"
              subtitle="Run Pane on a persistent cloud VM"
              icon={<Cloud className="w-5 h-5" />}
              defaultExpanded={false}
            >
              <SettingsSection
                title="Cloud Provider"
                description="Google Cloud Platform with IAP-secured access (no public IP)"
                icon={<Cloud className="w-4 h-4" />}
              >
                <div className="p-3 rounded-lg bg-surface-secondary border border-border-secondary">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">Google Cloud Platform</span>
                    <span className="px-2 py-0.5 text-xs bg-status-success/20 text-status-success rounded-full">IAP Secured</span>
                  </div>
                  <p className="text-xs text-text-tertiary mt-1">e2-highmem-2 (2 vCPU, 16GB RAM) — access via IAP tunnel only, no public IP exposed</p>
                </div>
              </SettingsSection>

              <SettingsSection
                title="Setup"
                description="Run the interactive setup script to provision or re-authenticate your cloud VM"
                icon={<Play className="w-4 h-4" />}
              >
                <div className="p-3 rounded-lg bg-surface-secondary border border-border-secondary">
                  <p className="text-sm text-text-secondary mb-3">
                    Opens a terminal panel running the cloud setup script. Handles first-time provisioning, gcloud authentication, and reconnection.
                  </p>
                  {activeSessionId ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleRunCloudSetup}
                      disabled={cloudSetupLoading}
                    >
                      {cloudSetupLoading ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Terminal className="w-4 h-4 mr-2" />
                      )}
                      Run Cloud Setup
                    </Button>
                  ) : (
                    <p className="text-xs text-text-tertiary">
                      Create or select a session first to run the setup script.
                    </p>
                  )}
                </div>
              </SettingsSection>

              <SettingsSection
                title="API Token"
                description="Your GCP service account key or access token"
                icon={<Shield className="w-4 h-4" />}
              >
                <Input
                  label="API Token"
                  type="password"
                  value={cloudApiToken}
                  onChange={(e) => setCloudApiToken(e.target.value)}
                  placeholder="GCP access token..."
                  fullWidth
                  helperText="Required to manage your cloud VM. Never shared or logged."
                />
              </SettingsSection>

              <SettingsSection
                title="Server Details"
                description="VM identifiers from your Terraform output"
                icon={<FileText className="w-4 h-4" />}
              >
                <div className="space-y-3">
                  <Input
                    label="Server ID"
                    value={cloudServerId}
                    onChange={(e) => setCloudServerId(e.target.value)}
                    placeholder="e.g. pane-user123"
                    fullWidth
                    helperText="GCP instance name from terraform output"
                  />
                  <div className="relative">
                    <Input
                      label="VNC Password"
                      type="password"
                      value={cloudVncPassword}
                      onChange={(e) => setCloudVncPassword(e.target.value)}
                      placeholder="VNC password..."
                      fullWidth
                      helperText="Password for noVNC access (set during VM setup)"
                    />
                    {cloudVncPassword && (
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(cloudVncPassword);
                          setVncPasswordCopied(true);
                          setTimeout(() => setVncPasswordCopied(false), 2000);
                        }}
                        className="absolute right-2 top-[30px] p-1.5 rounded hover:bg-surface-secondary transition-colors"
                        title="Copy password"
                      >
                        {vncPasswordCopied ? (
                          <Check className="w-4 h-4 text-green-500" />
                        ) : (
                          <Copy className="w-4 h-4 text-text-secondary" />
                        )}
                      </button>
                    )}
                  </div>
                  <Input
                    label="Region"
                    value={cloudRegion}
                    onChange={(e) => setCloudRegion(e.target.value)}
                    placeholder="e.g. us-central1"
                    fullWidth
                  />
                  {cloudProvider === 'gcp' && (
                    <>
                      <Input
                        label="GCP Project ID"
                        value={cloudGcpProjectId}
                        onChange={(e) => setCloudGcpProjectId(e.target.value)}
                        placeholder="e.g. my-gcp-project"
                        fullWidth
                      />
                      <Input
                        label="GCP Zone"
                        value={cloudGcpZone}
                        onChange={(e) => setCloudGcpZone(e.target.value)}
                        placeholder="e.g. us-central1-a"
                        fullWidth
                      />
                      <Input
                        label="IAP Tunnel Port"
                        value={cloudTunnelPort}
                        onChange={(e) => setCloudTunnelPort(e.target.value)}
                        placeholder="8080"
                        fullWidth
                        helperText="Local port for IAP tunnel (default 8080). Must match --local-host-port in your gcloud tunnel command."
                      />
                    </>
                  )}
                </div>
              </SettingsSection>

              <SettingsSection
                title="Reset Cloud Configuration"
                description="Clear settings or destroy cloud infrastructure"
                icon={<Trash2 className="w-4 h-4" />}
              >
                <div className="space-y-3">
                  <div className="p-3 rounded-lg bg-surface-secondary border border-border-secondary">
                    <p className="text-sm text-text-secondary mb-3">
                      Clear local settings only. Use this if infrastructure was already destroyed or you want to re-configure.
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        setCloudApiToken('');
                        setCloudServerId('');
                        setCloudVncPassword('');
                        setCloudRegion('');
                        setCloudGcpProjectId('');
                        setCloudGcpZone('');
                        setCloudTunnelPort('8080');
                        // Auto-save the cleared config
                        try {
                          await API.config.update({
                            cloud: undefined,
                          });
                        } catch (err) {
                          console.error('Failed to clear cloud config:', err);
                        }
                      }}
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Clear Local Settings
                    </Button>
                  </div>
                  <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                    <p className="text-sm text-text-secondary mb-2">
                      To fully destroy the cloud VM and clean up GCP resources, run:
                    </p>
                    <code className="block text-xs bg-surface-primary p-2 rounded border border-border-primary mb-2 font-mono">
                      bash cloud/scripts/setup-cloud.sh --destroy
                    </code>
                    <p className="text-xs text-text-tertiary">
                      This will run terraform destroy and delete the GCP project.
                    </p>
                  </div>
                </div>
              </SettingsSection>
            </CollapsibleCard>

            {/* System Updates */}
            <CollapsibleCard
              title="Updates & Maintenance"
              subtitle="Keep Pane up to date with the latest features"
              icon={<RefreshCw className="w-5 h-5" />}
              defaultExpanded={false}
            >
              <SettingsSection
                title="Automatic Updates"
                description="Stay current with new features and bug fixes"
                icon={<RefreshCw className="w-4 h-4" />}
              >
                <div className="flex items-center justify-between p-3 bg-surface-secondary rounded-lg border border-border-secondary">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      label="Check for updates automatically"
                      checked={autoCheckUpdates}
                      onChange={(e) => setAutoCheckUpdates(e.target.checked)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      try {
                        const response = await API.checkForUpdates();
                        if (response.success && response.data) {
                          if (response.data.hasUpdate) {
                            // Update will be shown via the version update event
                          } else {
                            alert('You are running the latest version of Pane!');
                          }
                        }
                      } catch (error) {
                        console.error('Failed to check for updates:', error);
                        alert('Failed to check for updates. Please try again later.');
                      }
                    }}
                  >
                    Check Now
                  </Button>
                </div>
                <p className="text-xs text-text-tertiary mt-2">
                  We check GitHub for new releases every 24 hours. Updates require manual installation.
                </p>
              </SettingsSection>
            </CollapsibleCard>

            {/* Advanced Options */}
            <CollapsibleCard
              title="Advanced Options"
              subtitle="Technical settings for power users"
              icon={<Eye className="w-5 h-5" />}
              defaultExpanded={false}
              variant="subtle"
            >
              <SettingsSection
                title="Debugging"
                description="Enable detailed logging for troubleshooting"
                icon={<FileText className="w-4 h-4" />}
              >
                <Checkbox
                  label="Enable verbose logging"
                  checked={verbose}
                  onChange={(e) => setVerbose(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  Shows detailed logs for pane creation and Claude Code execution. Useful for debugging issues.
                </p>
                
                <div className="mt-4">
                  <Checkbox
                    label="Enable dev mode"
                    checked={devMode}
                    onChange={(e) => setDevMode(e.target.checked)}
                  />
                  <p className="text-xs text-text-tertiary mt-1">
                    Adds a "Messages" tab to each pane showing raw JSON responses from Claude Code. Useful for debugging and development.
                  </p>
                </div>
              </SettingsSection>

              <SettingsSection
                title="Additional PATH Directories"
                description="Add custom directories to the PATH environment variable"
                icon={<FileText className="w-4 h-4" />}
              >
                <Textarea
                  label=""
                  value={additionalPathsText}
                  onChange={(e) => setAdditionalPathsText(e.target.value)}
                  placeholder={
                    platform === 'win32' 
                      ? "C:\\tools\\bin\nC:\\Program Files\\MyApp\n%USERPROFILE%\\bin"
                      : platform === 'darwin'
                      ? "/opt/homebrew/bin\n/usr/local/bin\n~/bin\n~/.cargo/bin"
                      : "/usr/local/bin\n/opt/bin\n~/bin\n~/.local/bin"
                  }
                  rows={4}
                  fullWidth
                  helperText={
                    `Enter one directory path per line. These will be added to PATH for all tools.\n${
                      platform === 'win32' 
                        ? "Windows: Use backslashes (C:\\path) or forward slashes (C:/path). Environment variables like %USERPROFILE% are supported."
                        : "Unix/macOS: Use forward slashes (/path). The tilde (~) expands to your home directory."
                    }\nNote: Changes require restarting Pane to take full effect.`
                  }
                />
              </SettingsSection>

              {platform === 'win32' && (
                <SettingsSection
                  title="Terminal Shell"
                  description="Default shell for terminal panels"
                  icon={<Terminal className="w-4 h-4" />}
                >
                  <Dropdown
                    trigger={
                      <button
                        type="button"
                        className="w-full px-4 py-3 bg-surface-secondary hover:bg-surface-hover rounded-lg transition-colors border border-border-secondary text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive cursor-pointer flex items-center justify-between"
                      >
                        <span>{preferredShell === 'auto' ? 'Auto-detect (Git Bash preferred)' : availableShells.find(s => s.id === preferredShell)?.name ?? preferredShell}</span>
                        <ChevronDown className="w-4 h-4 text-text-tertiary" />
                      </button>
                    }
                    items={[
                      { id: 'auto', label: 'Auto-detect (Git Bash preferred)', onClick: () => setPreferredShell('auto') },
                      ...availableShells.map(shell => ({
                        id: shell.id,
                        label: shell.name,
                        onClick: () => setPreferredShell(shell.id),
                      })),
                    ]}
                    selectedId={preferredShell}
                    position="bottom-left"
                    width="full"
                  />
                </SettingsSection>
              )}

              <SettingsSection
                title="Custom Claude Installation"
                description="Override the default Claude executable path"
                icon={<FileText className="w-4 h-4" />}
              >
                <div className="flex gap-2">
                  <input
                    id="claudeExecutablePath"
                    type="text"
                    value={claudeExecutablePath}
                    onChange={(e) => setClaudeExecutablePath(e.target.value)}
                    className="flex-1 px-3 py-2 border border-border-primary rounded-md focus:outline-none focus:ring-2 focus:ring-interactive text-text-primary bg-surface-secondary"
                    placeholder="/usr/local/bin/claude"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      const result = await API.dialog.openFile({
                        title: 'Select Claude Executable',
                        buttonLabel: 'Select',
                        properties: ['openFile'],
                        filters: [
                          { name: 'Executables', extensions: ['*'] }
                        ]
                      });
                      if (result.success && result.data) {
                        setClaudeExecutablePath(result.data);
                      }
                    }}
                  >
                    Browse
                  </Button>
                </div>
                <p className="text-xs text-text-tertiary mt-1">
                  Leave empty to use the 'claude' command from your system PATH.
                </p>
              </SettingsSection>
            </CollapsibleCard>

            {error && (
              <div className="text-status-error text-sm bg-status-error/10 border border-status-error/30 rounded-lg p-4">
                {error}
              </div>
            )}
          </form>
        )}
        
        {activeTab === 'notifications' && (
          <NotificationSettings
            settings={notificationSettings}
            onUpdateSettings={(updates) => {
              setNotificationSettings(prev => ({ ...prev, ...updates }));
            }}
          />
        )}

        {activeTab === 'shortcuts' && (
          <form id="shortcuts-form" onSubmit={handleSubmit} className="space-y-6">
            <div className="flex items-center gap-3 mb-2">
              <Keyboard className="w-5 h-5 text-text-secondary" />
              <div>
                <h3 className="text-sm font-medium text-text-primary">Terminal Shortcuts</h3>
                <p className="text-xs text-text-tertiary">Bind Ctrl+Alt+letter shortcuts to paste text snippets anywhere</p>
              </div>
            </div>

            <div className="space-y-4">
              {terminalShortcuts.map((shortcut, index) => (
                <div key={shortcut.id} className="p-3 rounded-lg bg-surface-secondary border border-border-secondary space-y-3">
                  <div className="flex items-center gap-3">
                    <Input
                      label="Label"
                      value={shortcut.label}
                      onChange={(e) => {
                        const updated = [...terminalShortcuts];
                        updated[index] = { ...updated[index], label: e.target.value };
                        setTerminalShortcuts(updated);
                      }}
                      placeholder="e.g. Run tests"
                      fullWidth
                    />
                    <div className="flex-shrink-0 w-24">
                      <Input
                        label="Key"
                        value={shortcut.key}
                        onChange={(e) => {
                          const val = e.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 1);
                          const updated = [...terminalShortcuts];
                          updated[index] = { ...updated[index], key: val };
                          setTerminalShortcuts(updated);
                        }}
                        placeholder="a-z"
                        fullWidth
                      />
                    </div>
                    <div className="flex-shrink-0 flex items-end gap-1 pb-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...terminalShortcuts];
                          updated[index] = { ...updated[index], enabled: !updated[index].enabled };
                          setTerminalShortcuts(updated);
                        }}
                        className={`p-2 rounded-md transition-colors ${
                          shortcut.enabled
                            ? 'text-status-success hover:bg-status-success/10'
                            : 'text-text-tertiary hover:bg-surface-hover'
                        }`}
                        title={shortcut.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                      >
                        {shortcut.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTerminalShortcuts(terminalShortcuts.filter((_, i) => i !== index));
                        }}
                        className="p-2 rounded-md text-text-tertiary hover:text-status-error hover:bg-status-error/10 transition-colors"
                        title="Delete shortcut"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <Textarea
                    label="Snippet text"
                    value={shortcut.text}
                    onChange={(e) => {
                      const updated = [...terminalShortcuts];
                      updated[index] = { ...updated[index], text: e.target.value };
                      setTerminalShortcuts(updated);
                    }}
                    placeholder="Text to paste when shortcut is triggered..."
                    rows={2}
                    fullWidth
                  />
                  <p className="text-xs text-text-tertiary">
                    {shortcut.key ? `Hotkey: ${formatKeyDisplay('mod+alt+' + shortcut.key)}` : 'Set a key (a-z) to assign a hotkey'}
                  </p>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setTerminalShortcuts([
                    ...terminalShortcuts,
                    {
                      id: crypto.randomUUID(),
                      label: '',
                      key: '',
                      text: '',
                      enabled: true,
                    },
                  ]);
                }}
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Shortcut
              </Button>
              {terminalShortcuts.length === 0 && (
                <p className="text-sm text-text-tertiary">
                  No shortcuts configured. Add one to bind a Ctrl+Alt+letter hotkey that pastes text into any terminal or input field.
                </p>
              )}
            </div>

            {error && (
              <div className="text-status-error text-sm bg-status-error/10 border border-status-error/30 rounded-lg p-4">
                {error}
              </div>
            )}
          </form>
        )}

        {activeTab === 'analytics' && (
          <form id="analytics-form" onSubmit={handleSubmit} className="space-y-6">
            {/* Analytics Overview */}
            <CollapsibleCard
              title="About Analytics"
              subtitle="Help improve Pane by sharing anonymous usage data"
              icon={<BarChart3 className="w-5 h-5" />}
              defaultExpanded={true}
              variant="subtle"
            >
              <div className="space-y-4">
                <p className="text-sm text-text-secondary leading-relaxed">
                  Pane collects anonymous usage analytics to understand how the application is used and to help prioritize improvements. All data is completely anonymous and privacy-focused.
                </p>

                <div className="bg-surface-tertiary rounded-lg p-4 border border-border-secondary">
                  <h4 className="font-medium text-text-primary mb-3 text-sm">✅ What we track:</h4>
                  <ul className="space-y-1 text-xs text-text-secondary">
                    <li>• Feature usage patterns (which features are used)</li>
                    <li>• Pane counts and statuses</li>
                    <li>• Git operation types (rebase, squash, etc.)</li>
                    <li>• UI interactions (view switches, button clicks)</li>
                    <li>• Error types (generic categories only)</li>
                    <li>• Performance metrics (categorized durations)</li>
                  </ul>
                </div>

                <div className="bg-status-error/10 rounded-lg p-4 border border-status-error/30">
                  <h4 className="font-medium text-text-primary mb-3 text-sm">❌ What we NEVER track:</h4>
                  <ul className="space-y-1 text-xs text-text-secondary">
                    <li>• Your prompts or AI responses</li>
                    <li>• File paths, names, or directory structures</li>
                    <li>• Project names or descriptions</li>
                    <li>• Git commit messages or code diffs</li>
                    <li>• Terminal output or commands</li>
                    <li>• Personal identifiers (emails, usernames, API keys)</li>
                  </ul>
                </div>

                <p className="text-xs text-text-tertiary italic">
                  You can opt-out at any time. When disabled, no analytics data will be collected or sent.
                </p>
              </div>
            </CollapsibleCard>

            {/* Analytics Settings */}
            <CollapsibleCard
              title="Analytics Settings"
              subtitle="Configure anonymous usage tracking"
              icon={<BarChart3 className="w-5 h-5" />}
              defaultExpanded={true}
            >
              <SettingsSection
                title="Enable Analytics"
                description="Allow Pane to collect anonymous usage data to improve the product"
                icon={<BarChart3 className="w-4 h-4" />}
              >
                <Checkbox
                  label="Enable anonymous analytics tracking"
                  checked={analyticsEnabled}
                  onChange={(e) => setAnalyticsEnabled(e.target.checked)}
                />
                {!analyticsEnabled && (
                  <p className="text-xs text-status-warning mt-2">
                    Analytics is disabled. No data will be collected or sent.
                  </p>
                )}
                {analyticsEnabled && (
                  <p className="text-xs text-status-success mt-2">
                    Analytics is enabled. Thank you for helping improve Pane!
                  </p>
                )}
              </SettingsSection>
            </CollapsibleCard>

            {error && (
              <div className="text-status-error text-sm bg-status-error/10 border border-status-error/30 rounded-lg p-4">
                {error}
              </div>
            )}
          </form>
        )}

      </ModalBody>

      {/* Footer */}
      {(activeTab === 'general' || activeTab === 'notifications' || activeTab === 'shortcuts' || activeTab === 'analytics') && (
        <ModalFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type={activeTab === 'general' || activeTab === 'shortcuts' ? 'submit' : 'button'}
            form={activeTab === 'general' ? 'settings-form' : activeTab === 'shortcuts' ? 'shortcuts-form' : undefined}
            onClick={activeTab === 'notifications' ? (e) => handleSubmit(e as React.FormEvent) : undefined}
            disabled={isSubmitting}
            loading={isSubmitting}
            variant="primary"
          >
            Save Changes
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
}
