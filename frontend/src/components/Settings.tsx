import { useCallback, useEffect, useRef, useState } from 'react';
import { NotificationSettings } from './NotificationSettings';
import { useNotifications } from '../hooks/useNotifications';
import { API } from '../utils/api';
import { optIn, capture, captureAndOptOut } from '../services/posthog';
import type { PreferredShell, TerminalShortcut } from '../types/config';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';
import { DEFAULT_WORKTREE_FILE_SYNC_ENTRIES } from '../../../shared/types/worktreeFileSync';
import {
  createDefaultRemoteDaemonConfig,
  createDefaultRemoteDaemonHostRuntimeState,
  createDefaultRemotePaneConnectionState,
  type RemoteDaemonConfig,
  type RemoteDaemonConnectedClient,
  type RemoteDaemonHostConfig,
  type RemoteDaemonHostRuntimeState,
  type RemoteHostSetupRequest,
  type RemoteHostSetupResult,
  type RemoteSetupDataDirectoryMode,
  type RemoteSetupTunnelPreference,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';
import { useConfigStore } from '../stores/configStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { panelApi } from '../services/panelApi';
import {
  Settings as SettingsIcon,
  Palette,
  Zap,
  RefreshCw,
  FileText,
  Eye,
  BarChart3,
  ChevronUp,
  ChevronDown,
  Terminal,
  Trash2,
  Keyboard,
  Plus,
  Power,
  PowerOff,
  FolderSync,
  CheckCircle2,
  AlertCircle,
  Copy,
  Server,
  ExternalLink
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

type AvailableShell = {
  id: PreferredShell;
  name: string;
  path: string;
};

function formatRemoteBaseUrl(host: string, port: number): string {
  const trimmedHost = host.trim();
  const normalizedHost = trimmedHost.includes(':') && !trimmedHost.startsWith('[') && !trimmedHost.endsWith(']')
    ? `[${trimmedHost}]`
    : trimmedHost;
  return `http://${normalizedHost}:${port}`;
}

function getRemoteProfileHostname(profile: RemotePaneConnectionProfile): string | null {
  try {
    return new URL(profile.baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isTailscaleRemoteProfile(profile: RemotePaneConnectionProfile): boolean {
  return profile.tunnel?.kind === 'tailscale' || getRemoteProfileHostname(profile)?.endsWith('.ts.net') === true;
}

function isTailscaleDnsConnectionFailure(profile: RemotePaneConnectionProfile | null | undefined, errorMessage: string | null | undefined): boolean {
  if (!profile || !errorMessage || !isTailscaleRemoteProfile(profile)) {
    return false;
  }

  const normalizedError = errorMessage.toLowerCase();
  return normalizedError.includes('enotfound')
    || normalizedError.includes('getaddrinfo')
    || normalizedError.includes('eai_again')
    || normalizedError.includes('enodata');
}

function formatRemoteLastSeen(lastSeenAt: string | null): string | null {
  if (!lastSeenAt) {
    return null;
  }

  const seenAtMs = Date.parse(lastSeenAt);
  if (Number.isNaN(seenAtMs)) {
    return null;
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - seenAtMs) / 1000));
  if (ageSeconds < 10) {
    return 'Last seen just now.';
  }
  if (ageSeconds < 60) {
    return `Last seen ${ageSeconds}s ago.`;
  }

  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `Last seen ${ageMinutes}m ago.`;
  }

  return `Last seen ${new Date(seenAtMs).toLocaleString()}.`;
}

function formatRemoteHostClients(state: RemoteDaemonHostRuntimeState): string {
  if (state.connectedClients.length === 0) {
    return 'No remote clients are connected.';
  }

  const displayLabels = state.connectedClients
    .map(getRemoteClientDisplayLabel)
    .filter((label): label is string => Boolean(label))
    .slice(0, 3);
  const clientNoun = state.connectedClients.length === 1 ? 'client is' : 'clients are';
  if (displayLabels.length === 0) {
    return `${state.connectedClients.length} remote ${clientNoun} connected.`;
  }

  const labels = displayLabels.join(', ');
  const remaining = state.connectedClients.length - displayLabels.length;
  return `${state.connectedClients.length} remote ${clientNoun} connected: ${labels}${remaining > 0 ? `, +${remaining} more` : ''}.`;
}

function getRemoteClientDisplayLabel(client: RemoteDaemonConnectedClient): string | null {
  return client.deviceLabel ?? client.remoteAddress;
}

function getRemoteHostRuntimePresentation(state: RemoteDaemonHostRuntimeState): {
  dotClassName: string;
  borderClassName: string;
  title: string;
  description: string;
} {
  if (state.status === 'live') {
    return {
      dotClassName: 'bg-status-success',
      borderClassName: 'bg-status-success/10 border-status-success/30',
      title: 'Remote host live',
      description: state.listenHost && state.listenPort
        ? `This Pane app is accepting remote connections on ${state.listenHost}:${state.listenPort}. ${formatRemoteHostClients(state)} Keep Pane open for Current Pane Data connections.`
        : `This Pane app is accepting remote connections. ${formatRemoteHostClients(state)} Keep Pane open for Current Pane Data connections.`,
    };
  }

  if (state.status === 'error') {
    return {
      dotClassName: 'bg-status-error',
      borderClassName: 'bg-status-error/10 border-status-error/30',
      title: 'Remote host offline',
      description: state.lastError ?? 'Pane could not start the remote listener on this machine.',
    };
  }

  return {
    dotClassName: 'bg-text-tertiary',
    borderClassName: 'bg-surface-secondary border-border-secondary',
    title: state.enabled ? 'Remote host configured, not live' : 'Remote host inactive',
    description: 'Run setup or reopen Pane on this machine to make existing remote profiles connect.',
  };
}

export function Settings({ isOpen, onClose, initialSection }: SettingsProps) {
  const [verbose, setVerbose] = useState(false);
  const [claudeExecutablePath, setClaudeExecutablePath] = useState('');
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [devMode, setDevMode] = useState(false);
  const [usePtyHost, setUsePtyHost] = useState(false);
  const [initialUsePtyHost, setInitialUsePtyHost] = useState(false);
  const [additionalPathsText, setAdditionalPathsText] = useState('');
  const [platform, setPlatform] = useState<string>('darwin');
  const [enableCommitFooter, setEnableCommitFooter] = useState(true);
  const [autoRenameToPR, setAutoRenameToPR] = useState<boolean>(true);
  const [uiScale, setUiScale] = useState(1.0);
  const [terminalFontFamily, setTerminalFontFamily] = useState('');
  const [terminalFontSize, setTerminalFontSize] = useState(14);
  const [systemMonoFonts, setSystemMonoFonts] = useState<string[]>([]);
  const [fontSearch, setFontSearch] = useState('');
  const [isFontDropdownOpen, setIsFontDropdownOpen] = useState(false);
  const [atPasteMode, setAtPasteMode] = useState<'raw' | 'embed'>('raw');
  const [atLineCount, setAtLineCount] = useState(500);
  const [notificationSettings, setNotificationSettings] = useState({
    playSound: true,
    enabled: true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'notifications' | 'shortcuts'>('general');
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);
  const [previousAnalyticsEnabled, setPreviousAnalyticsEnabled] = useState(true);
  const [preferredShell, setPreferredShell] = useState<PreferredShell>('auto');
  const [availableShells, setAvailableShells] = useState<AvailableShell[]>([]);
  const [terminalShortcuts, setTerminalShortcuts] = useState<TerminalShortcut[]>([]);
  const [worktreeFileSync, setWorktreeFileSync] = useState<WorktreeFileSyncEntry[]>([]);
  const [remoteDaemonConfig, setRemoteDaemonConfig] = useState<RemoteDaemonConfig>(createDefaultRemoteDaemonConfig());
  const [remoteConnectionState, setRemoteConnectionState] = useState<RemotePaneConnectionState>(createDefaultRemotePaneConnectionState());
  const [remoteHostState, setRemoteHostState] = useState<RemoteDaemonHostRuntimeState>(createDefaultRemoteDaemonHostRuntimeState());
  const [remoteHostConfigDraft, setRemoteHostConfigDraft] = useState<RemoteDaemonHostConfig>(createDefaultRemoteDaemonConfig().host.config);
  const [remotePairLabel, setRemotePairLabel] = useState('');
  const [remotePairBaseUrl, setRemotePairBaseUrl] = useState('http://127.0.0.1:42137');
  const [remoteCreatedToken, setRemoteCreatedToken] = useState<string | null>(null);
  const [remoteConnectionCode, setRemoteConnectionCode] = useState('');
  const [remoteImportResult, setRemoteImportResult] = useState<string | null>(null);
  const [remoteImportedProfileLabel, setRemoteImportedProfileLabel] = useState('');
  const [remoteImportedProfileBaseUrl, setRemoteImportedProfileBaseUrl] = useState('http://127.0.0.1:42137');
  const [remoteImportedProfileToken, setRemoteImportedProfileToken] = useState('');
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteSetupTerminalBusy, setRemoteSetupTerminalBusy] = useState(false);
  const [remoteClientSetupTerminalBusy, setRemoteClientSetupTerminalBusy] = useState(false);
  const [remoteClientSetupError, setRemoteClientSetupError] = useState<string | null>(null);
  const [remoteImportRecoveryProfileId, setRemoteImportRecoveryProfileId] = useState<string | null>(null);
  const [remoteImportRecoveryError, setRemoteImportRecoveryError] = useState<string | null>(null);
  const [remoteSetupDataMode, setRemoteSetupDataMode] = useState<RemoteSetupDataDirectoryMode>('current');
  const [remoteSetupLabel, setRemoteSetupLabel] = useState('');
  const [remoteSetupListenPort, setRemoteSetupListenPort] = useState(42137);
  const [remoteSetupPaneDir, setRemoteSetupPaneDir] = useState('');
  const [remoteSetupTunnelPreference, setRemoteSetupTunnelPreference] = useState<RemoteSetupTunnelPreference>('tailscale');
  const [remoteSetupManualBaseUrl, setRemoteSetupManualBaseUrl] = useState('');
  const [remoteSetupInstallService, setRemoteSetupInstallService] = useState(true);
  const [remoteSetupResult, setRemoteSetupResult] = useState<RemoteHostSetupResult | null>(null);
  const [remoteSetupCopyResult, setRemoteSetupCopyResult] = useState<string | null>(null);
  const [remoteSetupError, setRemoteSetupError] = useState<string | null>(null);
  const fontsLoadedForOpenRef = useRef(false);
  const { updateSettings } = useNotifications();
  const { theme, setTheme } = useTheme();
  const { fetchConfig: refreshConfigStore } = useConfigStore();
  const activeProjectId = useNavigationStore((state) => state.activeProjectId);
  const navigateToSessions = useNavigationStore((state) => state.navigateToSessions);
  const activeSessionProjectId = useSessionStore((state) => {
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
      ?? state.activeMainRepoSession;
    return activeSession?.projectId ?? null;
  });
  const setActiveSession = useSessionStore((state) => state.setActiveSession);

  const refreshRemoteDaemonSettings = useCallback(async () => {
    const [configResponse, connectionStateResponse, hostStateResponse] = await Promise.all([
      API.remoteDaemon.getConfig(),
      API.remoteDaemon.getConnectionState(),
      API.remoteDaemon.getHostState(),
    ]);

    if (configResponse.success && configResponse.data) {
      setRemoteDaemonConfig(configResponse.data);
      setRemoteHostConfigDraft(configResponse.data.host.config);
      setRemoteSetupListenPort((currentValue) => (
        currentValue === 42137 ? configResponse.data!.host.config.listenPort : currentValue
      ));
      setRemotePairBaseUrl((currentValue) => (
        currentValue === 'http://127.0.0.1:42137'
          ? formatRemoteBaseUrl(
              configResponse.data!.host.config.listenHost,
              configResponse.data!.host.config.listenPort,
            )
          : currentValue
      ));
      setRemoteImportedProfileBaseUrl((currentValue) => (
        currentValue === 'http://127.0.0.1:42137'
          ? formatRemoteBaseUrl(
              configResponse.data!.host.config.listenHost,
              configResponse.data!.host.config.listenPort,
            )
          : currentValue
      ));
    }

    if (connectionStateResponse.success && connectionStateResponse.data) {
      setRemoteConnectionState(connectionStateResponse.data);
    }

    if (hostStateResponse.success && hostStateResponse.data) {
      setRemoteHostState(hostStateResponse.data);
    }
  }, []);

  const fetchConfig = useCallback(async (currentPlatform?: string) => {
    try {
      const response = await API.config.get();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to fetch config');
      }
      const data = response.data;
      setVerbose(data.verbose || false);
      setAutoCheckUpdates(data.autoCheckUpdates !== false); // Default to true
      setDevMode(data.devMode || false);
      setUsePtyHost(data.usePtyHost === true);
      setInitialUsePtyHost(data.usePtyHost === true);
      setClaudeExecutablePath(data.claudeExecutablePath || '');
      setEnableCommitFooter(data.enableCommitFooter !== false); // Default to true
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
        if (shellsResponse.success && shellsResponse.data) {
          setAvailableShells(shellsResponse.data);
        }
      }
      setPreferredShell(data.preferredShell || 'auto');

      // Load terminal shortcuts
      setTerminalShortcuts(data.terminalShortcuts ?? []);

      // Load worktree file sync entries
      setWorktreeFileSync(data.worktreeFileSync ?? DEFAULT_WORKTREE_FILE_SYNC_ENTRIES);

      await refreshRemoteDaemonSettings();
    } catch {
      setError('Failed to load configuration');
    }
  }, [platform, refreshRemoteDaemonSettings, updateSettings]);

  useEffect(() => {
    if (isOpen) {
      // Get platform first, then fetch config (needed for Windows shell detection)
      window.electronAPI.getPlatform().then((p) => {
        setPlatform(p);
        fetchConfig(p);
      });

      const unsubscribeRemoteConnectionState = window.electronAPI.remoteDaemon.onConnectionStateChanged((state) => {
        setRemoteConnectionState(state);
      });
      const unsubscribeRemoteHostState = window.electronAPI.remoteDaemon.onHostStateChanged((state) => {
        setRemoteHostState(state);
      });

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

      // Load @terminal preferences
      const loadAtTerminalPrefs = async () => {
        try {
          const [modeResult, lineResult] = await Promise.all([
            window.electron?.invoke('preferences:get', 'at_terminal_paste_mode') as Promise<IPCResponse<string>>,
            window.electron?.invoke('preferences:get', 'at_terminal_line_count') as Promise<IPCResponse<string>>,
          ]);
          if (modeResult?.data === 'raw' || modeResult?.data === 'embed') {
            setAtPasteMode(modeResult.data);
          }
          if (lineResult?.data) {
            const val = parseInt(lineResult.data, 10);
            if ([100, 300, 500, -1].includes(val)) setAtLineCount(val);
          }
        } catch { /* ignore */ }
      };
      loadAtTerminalPrefs();

      // Navigate to shortcuts tab when opened via Ctrl+Alt+/
      if (initialSection === 'terminal-shortcuts') {
        setActiveTab('shortcuts');
      }

      return () => {
        unsubscribeRemoteConnectionState();
        unsubscribeRemoteHostState();
      };
    }
  }, [fetchConfig, initialSection, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      fontsLoadedForOpenRef.current = false;
      return;
    }

    if (fontsLoadedForOpenRef.current) {
      return;
    }
    fontsLoadedForOpenRef.current = true;

    // macOS font enumeration can be expensive; keep it out of the broad
    // settings refresh effect so state sync cannot repeatedly spawn it.
    let cancelled = false;
    window.electronAPI.config.getMonospaceFonts().then((result) => {
      if (!cancelled && result?.data && Array.isArray(result.data)) {
        setSystemMonoFonts(result.data as string[]);
      }
    }).catch(() => { /* fc-list not available — dropdown will be empty */ });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const runRemoteDaemonAction = async (
    action: () => Promise<void>,
    options: {
      onError?: (message: string) => void;
      mirrorErrorToGlobal?: boolean;
    } = {},
  ) => {
    setRemoteBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([
        refreshRemoteDaemonSettings(),
        refreshConfigStore(),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Remote daemon action failed';
      options.onError?.(message);
      if (options.mirrorErrorToGlobal !== false) {
        setError(message);
      }
    } finally {
      setRemoteBusy(false);
    }
  };

  const handleSaveRemoteHostConfig = async () => {
    await runRemoteDaemonAction(async () => {
      const response = await API.remoteDaemon.updateHostConfig(remoteHostConfigDraft);
      if (!response.success) {
        throw new Error(response.error || 'Failed to save remote daemon host config');
      }
    });
  };

  const buildRemoteHostSetupRequest = (): RemoteHostSetupRequest => ({
    dataDirectoryMode: remoteSetupDataMode,
    label: remoteSetupLabel,
    listenPort: remoteSetupListenPort,
    paneDir: remoteSetupDataMode === 'isolated' && remoteSetupPaneDir.trim().length > 0
      ? remoteSetupPaneDir
      : undefined,
    preferTunnel: remoteSetupTunnelPreference,
    baseUrl: remoteSetupTunnelPreference === 'manual' && remoteSetupManualBaseUrl.trim().length > 0
      ? remoteSetupManualBaseUrl
      : undefined,
    installService: remoteSetupDataMode === 'isolated' ? remoteSetupInstallService : false,
  });

  const handleSetupRemoteHost = async () => {
    await runRemoteDaemonAction(async () => {
      setRemoteSetupResult(null);
      setRemoteSetupCopyResult(null);
      setRemoteSetupError(null);
      const response = await API.remoteDaemon.setupHost(buildRemoteHostSetupRequest());
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to set up this machine as a remote');
      }

      setRemoteSetupResult(response.data);
      setRemoteSetupLabel('');
    }, {
      onError: setRemoteSetupError,
      mirrorErrorToGlobal: false,
    });
  };

  const handleOpenRemoteSetupTerminal = async () => {
    const projectId = activeProjectId ?? activeSessionProjectId;
    if (!projectId) {
      setRemoteSetupError('Select a project before opening a setup terminal.');
      return;
    }

    setRemoteSetupTerminalBusy(true);
    setRemoteSetupError(null);
    setRemoteSetupResult(null);
    setRemoteSetupCopyResult(null);

    try {
      const commandResponse = await API.remoteDaemon.getInteractiveSetupCommand(buildRemoteHostSetupRequest());
      if (!commandResponse.success || !commandResponse.data?.command) {
        throw new Error(commandResponse.error || 'Failed to prepare the remote setup command');
      }

      const sessionResponse = await API.sessions.getOrCreateMainRepoSession(projectId);
      if (!sessionResponse.success || !sessionResponse.data?.id) {
        throw new Error(sessionResponse.error || 'Failed to open a project terminal');
      }

      const sessionId = sessionResponse.data.id as string;
      const panel = await panelApi.createPanel({
        sessionId,
        type: 'terminal',
        title: 'Tailscale Setup',
        initialState: {
          customState: {
            initialCommand: commandResponse.data.command,
          },
        },
      });

      await panelApi.setActivePanel(sessionId, panel.id);
      await setActiveSession(sessionId);
      navigateToSessions();
      onClose();
    } catch (err) {
      setRemoteSetupError(err instanceof Error ? err.message : 'Failed to open setup terminal');
    } finally {
      setRemoteSetupTerminalBusy(false);
    }
  };

  const handleOpenTailscaleClientSetupTerminal = async () => {
    const projectId = activeProjectId ?? activeSessionProjectId;
    if (!projectId) {
      setRemoteClientSetupError('Select a project before opening a Tailscale setup terminal.');
      return;
    }

    setRemoteClientSetupTerminalBusy(true);
    setRemoteClientSetupError(null);
    setError(null);

    try {
      const commandResponse = await API.remoteDaemon.getInteractiveClientSetupCommand();
      if (!commandResponse.success || !commandResponse.data?.command) {
        throw new Error(commandResponse.error || 'Failed to prepare the Tailscale setup command');
      }

      if (remoteConnectionState.mode === 'remote') {
        const localResponse = await API.remoteDaemon.updateClientState({
          activeProfileId: null,
          mode: 'local',
        });
        if (!localResponse.success) {
          throw new Error(localResponse.error || 'Failed to switch to local runtime before opening Tailscale setup');
        }
      }

      const sessionResponse = await API.sessions.getOrCreateMainRepoSession(projectId);
      if (!sessionResponse.success || !sessionResponse.data?.id) {
        throw new Error(sessionResponse.error || 'Failed to open a project terminal');
      }

      const sessionId = sessionResponse.data.id as string;
      const panel = await panelApi.createPanel({
        sessionId,
        type: 'terminal',
        title: 'Tailscale Client Setup',
        initialState: {
          customState: {
            initialCommand: commandResponse.data.command,
          },
        },
      });

      await panelApi.setActivePanel(sessionId, panel.id);
      await setActiveSession(sessionId);
      navigateToSessions();
      onClose();
    } catch (err) {
      setRemoteClientSetupError(err instanceof Error ? err.message : 'Failed to open Tailscale setup terminal');
    } finally {
      setRemoteClientSetupTerminalBusy(false);
    }
  };

  const handleCopyRemoteSetupConnectionCode = async () => {
    if (!remoteSetupResult) {
      return;
    }
    try {
      await navigator.clipboard.writeText(remoteSetupResult.connectionCode);
      setRemoteSetupCopyResult('Copied connection code.');
    } catch {
      setError('Failed to copy connection code');
    }
  };

  const handleCreateRemoteConnectionPair = async () => {
    await runRemoteDaemonAction(async () => {
      const response = await API.remoteDaemon.createConnectionPair({
        label: remotePairLabel,
        baseUrl: remotePairBaseUrl,
      });
      if (!response.success) {
        throw new Error(response.error || 'Failed to create remote daemon connection pair');
      }

      setRemotePairLabel('');
      setRemoteCreatedToken(response.data?.token ?? null);
    });
  };

  const handleUseRemoteProfile = async (profileId: string) => {
    await runRemoteDaemonAction(async () => {
      setRemoteImportRecoveryProfileId(null);
      setRemoteImportRecoveryError(null);
      setRemoteClientSetupError(null);
      const response = await API.remoteDaemon.updateClientState({
        activeProfileId: profileId,
        mode: 'remote',
      });
      if (!response.success) {
        throw new Error(response.error || 'Failed to connect to remote daemon profile');
      }
    });
  };

  const handleSwitchToLocalMode = async () => {
    await runRemoteDaemonAction(async () => {
      const response = await API.remoteDaemon.updateClientState({
        mode: 'local',
      });
      if (!response.success) {
        throw new Error(response.error || 'Failed to return to local mode');
      }
    });
  };

  const handleDeleteRemoteProfile = async (profileId: string) => {
    await runRemoteDaemonAction(async () => {
      const response = await API.remoteDaemon.deleteConnectionProfile(profileId);
      if (!response.success) {
        throw new Error(response.error || 'Failed to delete remote daemon connection profile');
      }
    });
  };

  const handleSaveRemoteProfile = async () => {
    await runRemoteDaemonAction(async () => {
      const profile: RemotePaneConnectionProfile = {
        id: crypto.randomUUID(),
        label: remoteImportedProfileLabel.trim(),
        baseUrl: remoteImportedProfileBaseUrl.trim(),
        token: remoteImportedProfileToken.trim(),
        transport: 'http+sse',
      };

      const response = await API.remoteDaemon.upsertConnectionProfile(profile);
      if (!response.success) {
        throw new Error(response.error || 'Failed to save remote daemon connection profile');
      }

      setRemoteImportedProfileLabel('');
      setRemoteImportedProfileToken('');
    });
  };

  const handleImportRemoteConnectionCode = async () => {
    await runRemoteDaemonAction(async () => {
      setRemoteImportResult(null);
      setRemoteImportRecoveryProfileId(null);
      setRemoteImportRecoveryError(null);
      setRemoteClientSetupError(null);
      const response = await API.remoteDaemon.importConnectionCode(remoteConnectionCode, {
        connect: true,
      });
      if (!response.success) {
        throw new Error(response.error || 'Failed to import remote daemon connection code');
      }

      const result = response.data;
      setRemoteConnectionCode('');
      if (result?.connected) {
        setRemoteImportResult(`Connected to ${result.profile.label}.`);
      } else if (result?.connectionError) {
        setRemoteImportResult(`Saved ${result.profile.label}, but connection failed: ${result.connectionError}`);
        if (isTailscaleDnsConnectionFailure(result.profile, result.connectionError)) {
          setRemoteImportRecoveryProfileId(result.profile.id);
          setRemoteImportRecoveryError(result.connectionError);
        }
      } else if (result?.profile) {
        setRemoteImportResult(`Saved ${result.profile.label}.`);
      }
    });
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
        autoCheckUpdates,
        devMode,
        usePtyHost,
        claudeExecutablePath,
        enableCommitFooter,
        uiScale,
        additionalPaths: parsedPaths,
        notifications: notificationSettings,
        analytics: {
          enabled: analyticsEnabled
        },
        preferredShell,
        terminalShortcuts,
        worktreeFileSync: filteredWorktreeFileSync,
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

  const remoteSetupRequiresManualBaseUrl =
    remoteSetupTunnelPreference === 'manual' && remoteSetupManualBaseUrl.trim().length === 0;
  const remoteSetupPortIsValid =
    Number.isInteger(remoteSetupListenPort) && remoteSetupListenPort > 0 && remoteSetupListenPort <= 65535;
  const remoteHostRuntimePresentation = getRemoteHostRuntimePresentation(remoteHostState);
  const remoteSetupFallbackCommands = remoteSetupResult
    ? remoteSetupResult.fallbackTunnelCommands.filter((command) => command !== remoteSetupResult.tunnel?.command)
    : [];
  const activeRemoteProfile = remoteConnectionState.activeProfileId
    ? remoteDaemonConfig.client.profiles.find((profile) => profile.id === remoteConnectionState.activeProfileId)
    : undefined;
  const importRecoveryProfile = remoteImportRecoveryProfileId
    ? remoteDaemonConfig.client.profiles.find((profile) => profile.id === remoteImportRecoveryProfileId)
    : undefined;
  const activeTailscaleDnsFailure = isTailscaleDnsConnectionFailure(activeRemoteProfile, remoteConnectionState.lastError);
  const importTailscaleDnsFailure = isTailscaleDnsConnectionFailure(importRecoveryProfile, remoteImportRecoveryError);
  const remoteLastSeenText = formatRemoteLastSeen(remoteConnectionState.lastSeenAt);
  const renderTailscaleClientRecovery = (
    profile: RemotePaneConnectionProfile | undefined,
    errorMessage: string | null,
  ) => {
    if (!profile || !errorMessage) {
      return null;
    }

    return (
      <div className="p-3 rounded-lg bg-status-warning/10 border border-status-warning/30 space-y-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-status-warning" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-text-primary">Set up Tailscale on this device</p>
            <p className="text-xs text-text-secondary">
              This profile uses Tailscale, but Pane cannot resolve {getRemoteProfileHostname(profile) ?? 'the remote host'}.
              Install Tailscale and sign in to the same account on this device, then retry the connection.
            </p>
            <p className="text-xs text-status-error">{errorMessage}</p>
          </div>
        </div>
        {remoteClientSetupError && (
          <div className="text-xs text-status-error bg-status-error/10 border border-status-error/30 rounded-md px-3 py-2">
            {remoteClientSetupError}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            icon={<Terminal className="w-4 h-4" />}
            onClick={handleOpenTailscaleClientSetupTerminal}
            disabled={remoteClientSetupTerminalBusy}
            loading={remoteClientSetupTerminalBusy}
            loadingText="Opening"
          >
            Open in Pane Terminal and Run Setup
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="w-4 h-4" />}
            onClick={() => handleUseRemoteProfile(profile.id)}
            disabled={remoteBusy}
          >
            Retry Connection
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<ExternalLink className="w-4 h-4" />}
            onClick={() => window.electronAPI.openExternal('https://tailscale.com/download')}
          >
            Open Tailscale Download
          </Button>
        </div>
      </div>
    );
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
        </div>

        {activeTab === 'general' && (
          <form id="settings-form" onSubmit={handleSubmit} className="space-y-6">
            <CollapsibleCard
              title="Remote Pane"
              subtitle="Connect this desktop app to a VM or another machine"
              icon={<Terminal className="w-5 h-5" />}
              defaultExpanded={true}
            >
              <SettingsSection
                title="Set Up This Machine"
                description="Create a cross-device connection code from this Pane install."
                icon={<Server className="w-4 h-4" />}
                spacing="sm"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRemoteSetupDataMode('current')}
                    className={`p-3 text-left rounded-lg border transition-colors ${
                      remoteSetupDataMode === 'current'
                        ? 'bg-interactive/10 border-interactive/40 text-text-primary'
                        : 'bg-surface-secondary border-border-secondary text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <span className="block text-sm font-medium">Current Pane Data</span>
                    <span className="block text-xs text-text-tertiary mt-1">
                      Use this app's projects; live while Pane is open.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoteSetupDataMode('isolated')}
                    className={`p-3 text-left rounded-lg border transition-colors ${
                      remoteSetupDataMode === 'isolated'
                        ? 'bg-interactive/10 border-interactive/40 text-text-primary'
                        : 'bg-surface-secondary border-border-secondary text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <span className="block text-sm font-medium">Isolated Daemon Data</span>
                    <span className="block text-xs text-text-tertiary mt-1">
                      Use separate daemon data and an optional background service.
                    </span>
                  </button>
                </div>

                <div className={`flex items-start gap-2 rounded-lg border p-3 ${remoteHostRuntimePresentation.borderClassName}`}>
                  <span className={`mt-1 h-2.5 w-2.5 rounded-full flex-shrink-0 ${remoteHostRuntimePresentation.dotClassName}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{remoteHostRuntimePresentation.title}</p>
                    <p className="text-xs text-text-tertiary mt-1">{remoteHostRuntimePresentation.description}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input
                    label="This Machine Label"
                    value={remoteSetupLabel}
                    onChange={(e) => setRemoteSetupLabel(e.target.value)}
                    placeholder="Office Mac mini"
                    fullWidth
                  />
                  <Input
                    label="Listen Port"
                    type="number"
                    value={String(remoteSetupListenPort)}
                    onChange={(e) => setRemoteSetupListenPort(Number.parseInt(e.target.value, 10) || 42137)}
                    error={remoteSetupPortIsValid ? undefined : 'Port must be between 1 and 65535'}
                    fullWidth
                  />
                </div>

                {remoteSetupDataMode === 'isolated' && (
                  <div className="space-y-3">
                    <Input
                      label="Daemon Data Directory"
                      value={remoteSetupPaneDir}
                      onChange={(e) => setRemoteSetupPaneDir(e.target.value)}
                      placeholder="Default: ~/.pane_remote"
                      fullWidth
                    />
                    <Checkbox
                      label="Install background service"
                      checked={remoteSetupInstallService}
                      onChange={(e) => setRemoteSetupInstallService(e.target.checked)}
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <p className="text-xs font-medium text-text-secondary">Access Mode</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    {[
                      ['tailscale', 'Tailscale', 'Recommended for another device or network.'],
                      ['ssh', 'SSH Tunnel', 'Advanced local forwarding.'],
                      ['manual', 'Manual HTTPS', 'Advanced custom tunnel URL.'],
                    ].map(([id, label, description]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setRemoteSetupTunnelPreference(id as RemoteSetupTunnelPreference)}
                        className={`p-3 text-left rounded-lg border transition-colors ${
                          remoteSetupTunnelPreference === id
                            ? 'bg-interactive/10 border-interactive/40 text-text-primary'
                            : 'bg-surface-secondary border-border-secondary text-text-secondary hover:bg-surface-hover'
                        }`}
                      >
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="block text-xs text-text-tertiary mt-1">{description}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {remoteSetupTunnelPreference === 'tailscale' && (
                  <p className="text-xs text-text-tertiary">
                    Pane can open a terminal that installs Tailscale if needed, walks through login, and configures Tailscale Serve for this daemon.
                  </p>
                )}

                {remoteSetupTunnelPreference === 'ssh' && (
                  <p className="text-xs text-status-warning">
                    SSH tunnel mode creates a localhost connection code and requires running the generated SSH command on the client machine before connecting.
                  </p>
                )}

                {remoteSetupTunnelPreference === 'manual' && (
                  <Input
                    label="Manual HTTPS Base URL"
                    value={remoteSetupManualBaseUrl}
                    onChange={(e) => setRemoteSetupManualBaseUrl(e.target.value)}
                    placeholder="https://pane-remote.example.com"
                    error={remoteSetupRequiresManualBaseUrl ? 'HTTPS base URL is required for manual mode' : undefined}
                    fullWidth
                  />
                )}

                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-text-tertiary">
                    Tailscale is recommended for another device or network. Current Pane Data keeps this host live while Pane is open; Isolated Daemon Data can install a service.
                  </p>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleSetupRemoteHost}
                    disabled={remoteBusy || !remoteSetupPortIsValid || remoteSetupRequiresManualBaseUrl}
                    loading={remoteBusy}
                    loadingText="Setting up"
                  >
                    {remoteSetupTunnelPreference === 'tailscale' ? 'Set Up Tailscale & Create Code' : 'Create Advanced Code'}
                  </Button>
                </div>

                {remoteSetupError && (
                  <div className="p-3 rounded-lg bg-status-error/10 border border-status-error/30 text-status-error space-y-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <p className="text-sm whitespace-pre-line">{remoteSetupError}</p>
                    </div>
                    {remoteSetupError.toLowerCase().includes('tailscale') && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          icon={<Terminal className="w-4 h-4" />}
                          onClick={handleOpenRemoteSetupTerminal}
                          disabled={remoteSetupTerminalBusy}
                          loading={remoteSetupTerminalBusy}
                          loadingText="Opening"
                        >
                          Open in Pane Terminal and Run Setup
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          icon={<ExternalLink className="w-4 h-4" />}
                          onClick={() => window.electronAPI.openExternal('https://tailscale.com/download')}
                        >
                          Open Tailscale Download
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {remoteSetupResult && (
                  <div className="p-3 rounded-lg bg-surface-secondary border border-border-secondary space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">Connection code ready</p>
                        <p className="text-xs text-text-tertiary mt-1 truncate">
                          {remoteSetupResult.label} · {remoteSetupResult.paneDir}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        icon={<Copy className="w-4 h-4" />}
                        onClick={handleCopyRemoteSetupConnectionCode}
                      >
                        Copy Code
                      </Button>
                    </div>
                    <Textarea
                      label="Connection Code"
                      value={remoteSetupResult.connectionCode}
                      onChange={() => {}}
                      rows={3}
                      readOnly
                      fullWidth
                    />
                    {remoteSetupCopyResult && (
                      <p className="text-xs text-status-success">{remoteSetupCopyResult}</p>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-text-tertiary">
                      <p className="break-all">Data directory: {remoteSetupResult.paneDir}</p>
                      <p className="break-all">Config: {remoteSetupResult.configPath}</p>
                      <p>Port: {remoteSetupResult.listenPort}</p>
                      <p>Service: {remoteSetupResult.service.strategy}</p>
                    </div>
                    <p className={`text-xs ${
                      remoteSetupResult.service.installed || remoteSetupResult.dataDirectoryMode === 'current'
                        ? 'text-text-tertiary'
                        : 'text-status-warning'
                    }`}>
                      {remoteSetupResult.dataDirectoryMode === 'current'
                        ? 'This Pane app is serving the remote listener. Reopen Pane on this machine when you want existing remote profiles to connect again.'
                        : remoteSetupResult.service.message}
                    </p>
                    {remoteSetupResult.tunnel?.command && (
                      <Textarea
                        label="Connection/Tunnel Command"
                        value={remoteSetupResult.tunnel.command}
                        onChange={() => {}}
                        rows={2}
                        readOnly
                        fullWidth
                      />
                    )}
                    {remoteSetupFallbackCommands.length > 0 && (
                      <Textarea
                        label="Fallback Tunnel Commands"
                        value={remoteSetupFallbackCommands.join('\n')}
                        onChange={() => {}}
                        rows={Math.min(3, remoteSetupFallbackCommands.length)}
                        readOnly
                        fullWidth
                      />
                    )}
                    {remoteSetupResult.dataDirectoryMode === 'isolated' && !remoteSetupResult.service.started && (
                      <Textarea
                        label="Manual Daemon Command"
                        value={remoteSetupResult.manualDaemonCommand}
                        onChange={() => {}}
                        rows={2}
                        readOnly
                        fullWidth
                      />
                    )}
                  </div>
                )}
              </SettingsSection>

              <SettingsSection
                title="Connection"
                description="Run remote setup on the machine that should host your worktrees and terminals, then paste the printed pane-remote:// code here."
                icon={<Power className="w-4 h-4" />}
                spacing="sm"
              >
                <div className="space-y-3 p-4 rounded-lg bg-surface-secondary border border-border-secondary">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-text-primary">Set up the remote host</p>
                      <p className="text-xs text-text-tertiary">
                        Pane runs a small headless daemon on the remote machine. This desktop app connects to it, so agents use that machine's repos, shell, Git config, and CLI credentials.
                      </p>
                    </div>
                    <a
                      href="https://runpane.com/docs/remote-daemon"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-interactive hover:text-interactive-hover transition-colors whitespace-nowrap"
                    >
                      Remote VM Setup
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium text-text-secondary">macOS / Linux</p>
                      <code className="block rounded-md bg-surface-primary border border-border-secondary px-3 py-2 text-xs text-text-primary overflow-x-auto">
                        curl -fsSL https://runpane.com/install-remote.sh | sh
                      </code>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium text-text-secondary">Windows PowerShell</p>
                      <code className="block rounded-md bg-surface-primary border border-border-secondary px-3 py-2 text-xs text-text-primary overflow-x-auto">
                        irm https://runpane.com/install-remote.ps1 | iex
                      </code>
                    </div>
                  </div>
                  <p className="text-xs text-text-tertiary">
                    Install Codex, Claude Code, or your preferred CLI agent on the remote host before starting agent panels.
                  </p>
                </div>

                <div className={`flex items-center justify-between gap-4 p-4 rounded-lg border ${
                  remoteConnectionState.status === 'connected'
                    ? 'bg-status-success/10 border-status-success/35'
                    : remoteConnectionState.status === 'error'
                      ? 'bg-status-error/10 border-status-error/35'
                      : 'bg-surface-secondary border-border-secondary'
                }`}>
                  <div className="flex items-start gap-3 min-w-0">
                    {remoteConnectionState.status === 'connected' ? (
                      <CheckCircle2 className="w-5 h-5 text-status-success mt-0.5 flex-shrink-0" />
                    ) : remoteConnectionState.status === 'error' ? (
                      <AlertCircle className="w-5 h-5 text-status-error mt-0.5 flex-shrink-0" />
                    ) : (
                      <Terminal className="w-5 h-5 text-text-tertiary mt-0.5 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">
                        {remoteConnectionState.status === 'connected'
                          ? `Connected to ${remoteConnectionState.activeProfileLabel ?? 'remote Pane'}`
                          : remoteConnectionState.mode === 'remote'
                            ? `Remote mode: ${remoteConnectionState.status}`
                            : 'Using local runtime'}
                      </p>
                      <p className="text-xs text-text-tertiary mt-1 truncate">
                        {remoteConnectionState.activeBaseUrl ?? 'Paste a connection code below to use a VM or another machine.'}
                      </p>
                      {remoteConnectionState.status === 'connected' && (
                        <p className="text-xs text-text-tertiary mt-2">
                          Worktrees, terminals, and AI tool commands run on the remote host. Install Codex or Claude there to use those panels.
                        </p>
                      )}
                      {remoteConnectionState.mode === 'remote' && remoteLastSeenText && (
                        <p className="text-xs text-text-tertiary mt-2">{remoteLastSeenText}</p>
                      )}
                      {remoteConnectionState.lastError && (
                        <p className="text-xs text-status-error mt-2">{remoteConnectionState.lastError}</p>
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleSwitchToLocalMode}
                    disabled={remoteBusy || remoteConnectionState.mode === 'local'}
                  >
                    Use Local Runtime
                  </Button>
                </div>

                {activeTailscaleDnsFailure && renderTailscaleClientRecovery(activeRemoteProfile, remoteConnectionState.lastError)}

                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
                  <Textarea
                    label="Connection Code"
                    value={remoteConnectionCode}
                    onChange={(e) => setRemoteConnectionCode(e.target.value)}
                    placeholder="pane-remote://..."
                    rows={2}
                    fullWidth
                  />
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleImportRemoteConnectionCode}
                    disabled={remoteBusy || remoteConnectionCode.trim().length === 0}
                    loading={remoteBusy && remoteConnectionCode.trim().length > 0}
                    loadingText="Connecting"
                    className="lg:mb-0.5"
                  >
                    Import & Connect
                  </Button>
                </div>

                {remoteImportResult && (
                  <p className={`text-xs ${
                    remoteImportResult.includes('failed') ? 'text-status-error' : 'text-status-success'
                  }`}>
                    {remoteImportResult}
                  </p>
                )}

                {importTailscaleDnsFailure && renderTailscaleClientRecovery(importRecoveryProfile, remoteImportRecoveryError)}

                {remoteDaemonConfig.client.profiles.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-text-secondary">Saved profiles</p>
                    {remoteDaemonConfig.client.profiles.map((profile) => {
                      const isActive = remoteDaemonConfig.client.activeProfileId === profile.id;
                      return (
                        <div
                          key={profile.id}
                          className={`flex items-center justify-between gap-3 p-3 rounded-lg border ${
                            isActive ? 'bg-status-success/10 border-status-success/35' : 'bg-surface-secondary border-border-secondary'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text-primary">
                              {profile.label}
                              {isActive && <span className="ml-2 text-xs text-status-success">connected</span>}
                            </p>
                            <p className="text-xs text-text-tertiary truncate">{profile.baseUrl}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant={isActive ? 'secondary' : 'primary'}
                              size="sm"
                              onClick={() => handleUseRemoteProfile(profile.id)}
                              disabled={remoteBusy || isActive}
                            >
                              {isActive ? 'Connected' : 'Connect'}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteRemoteProfile(profile.id)}
                              disabled={remoteBusy}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SettingsSection>
            </CollapsibleCard>

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
                            ? 'bg-interactive text-text-on-interactive border-interactive'
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
                                ? 'bg-interactive text-text-on-interactive border-interactive'
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

              <SettingsSection
                title="@ Terminal Reference"
                description="Type @ in any terminal to reference scrollback from other terminals in the same session"
                icon={<Terminal className="w-4 h-4" />}
              >
                <div className="space-y-4">
                  {/* Paste mode */}
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                      Default Paste Mode
                    </label>
                    <p className="text-[11px] text-text-tertiary mb-2">
                      How scrollback content is inserted when you select a terminal with <kbd className="px-1 py-0.5 rounded border border-border-primary/70 bg-surface-primary font-mono text-[10px]">Enter</kbd>. Toggle with <kbd className="px-1 py-0.5 rounded border border-border-primary/70 bg-surface-primary font-mono text-[10px]">Tab</kbd> in the popover.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setAtPasteMode('raw');
                          window.electron?.invoke('preferences:set', 'at_terminal_paste_mode', 'raw');
                        }}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm transition-colors ${
                          atPasteMode === 'raw'
                            ? 'bg-interactive text-text-on-interactive border-interactive'
                            : 'bg-surface-secondary text-text-secondary border-border-secondary hover:bg-surface-hover'
                        }`}
                      >
                        Raw Paste
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAtPasteMode('embed');
                          window.electron?.invoke('preferences:set', 'at_terminal_paste_mode', 'embed');
                        }}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm transition-colors ${
                          atPasteMode === 'embed'
                            ? 'bg-interactive text-text-on-interactive border-interactive'
                            : 'bg-surface-secondary text-text-secondary border-border-secondary hover:bg-surface-hover'
                        }`}
                      >
                        Embed File
                      </button>
                    </div>
                  </div>

                  {/* Default line count */}
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                      Default Line Count
                    </label>
                    <p className="text-[11px] text-text-tertiary mb-2">
                      Number of scrollback lines to include. Change with <kbd className="px-1 py-0.5 rounded border border-border-primary/70 bg-surface-primary font-mono text-[10px]">←→</kbd> in the popover.
                    </p>
                    <div className="flex gap-2">
                      {([100, 300, 500, -1] as const).map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            setAtLineCount(preset);
                            window.electron?.invoke('preferences:set', 'at_terminal_line_count', String(preset));
                          }}
                          className={`flex-1 px-3 py-2 rounded-lg border text-sm font-mono transition-colors ${
                            atLineCount === preset
                              ? 'bg-interactive text-text-on-interactive border-interactive'
                              : 'bg-surface-secondary text-text-secondary border-border-secondary hover:bg-surface-hover'
                          }`}
                        >
                          {preset === -1 ? 'All' : preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Live preview */}
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                      Preview
                    </label>
                    <div className="rounded-lg border border-border-primary/60 bg-surface-primary/95 overflow-hidden text-[12px]">
                      {/* Mock popover header */}
                      <div className="px-3 py-2 border-b border-border-subtle/50">
                        <div className="text-[13px] font-medium text-text-primary">Terminal 1</div>
                        <div className="text-[11px] text-text-tertiary font-mono mt-0.5 opacity-70">
                          <div>$ npm run build</div>
                          <div>Build completed in 2.3s</div>
                          <div>✓ 42 tests passed</div>
                        </div>
                      </div>
                      {/* Mock output */}
                      <div className="px-3 py-2 bg-black/20 font-mono text-[11px]">
                        {atPasteMode === 'raw' ? (
                          <div className="text-text-tertiary">
                            <div className="text-text-quaternary mb-1">→ Pastes {atLineCount === -1 ? 'all' : atLineCount} lines of clean text directly:</div>
                            <div className="text-green-400/70">$ npm run build</div>
                            <div className="text-text-tertiary">Build completed in 2.3s</div>
                            <div className="text-text-tertiary">✓ 42 tests passed</div>
                            <div className="text-text-quaternary">...</div>
                          </div>
                        ) : (
                          <div className="text-text-tertiary">
                            <div className="text-text-quaternary mb-1">→ Saves {atLineCount === -1 ? 'all' : atLineCount} lines to file, inserts reference:</div>
                            <div className="text-blue-400/70">[Pasted from Terminal 1] /mnt/c/Users/.../.pane/files/scrollback.txt</div>
                          </div>
                        )}
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

            <CollapsibleCard
              title="Advanced Remote Pane"
              subtitle="Host listener settings and manual daemon profile tools"
              icon={<Terminal className="w-5 h-5" />}
              defaultExpanded={false}
            >
              <SettingsSection
                title="Connect To Remote Pane"
                description="Paste a pane-remote:// code from remote setup. Pane saves the profile and switches to it automatically."
                icon={<Power className="w-4 h-4" />}
                spacing="sm"
              >
                <div className={`flex items-center justify-between gap-4 p-4 rounded-lg border ${
                  remoteConnectionState.status === 'connected'
                    ? 'bg-status-success/10 border-status-success/35'
                    : remoteConnectionState.status === 'error'
                      ? 'bg-status-error/10 border-status-error/35'
                      : 'bg-surface-secondary border-border-secondary'
                }`}>
                  <div className="flex items-start gap-3 min-w-0">
                    {remoteConnectionState.status === 'connected' ? (
                      <CheckCircle2 className="w-5 h-5 text-status-success mt-0.5 flex-shrink-0" />
                    ) : remoteConnectionState.status === 'error' ? (
                      <AlertCircle className="w-5 h-5 text-status-error mt-0.5 flex-shrink-0" />
                    ) : (
                      <Terminal className="w-5 h-5 text-text-tertiary mt-0.5 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">
                        {remoteConnectionState.status === 'connected'
                          ? `Connected to ${remoteConnectionState.activeProfileLabel ?? 'remote Pane'}`
                          : remoteConnectionState.mode === 'remote'
                            ? `Remote mode: ${remoteConnectionState.status}`
                            : 'Using local runtime'}
                      </p>
                      <p className="text-xs text-text-tertiary mt-1 truncate">
                        {remoteConnectionState.activeBaseUrl ?? 'Paste a connection code below to use a VM or another machine.'}
                      </p>
                      {remoteConnectionState.lastError && (
                        <p className="text-xs text-status-error mt-2">{remoteConnectionState.lastError}</p>
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleSwitchToLocalMode}
                    disabled={remoteBusy || remoteConnectionState.mode === 'local'}
                  >
                    Use Local Runtime
                  </Button>
                </div>

                {activeTailscaleDnsFailure && renderTailscaleClientRecovery(activeRemoteProfile, remoteConnectionState.lastError)}

                <div className="space-y-3">
                  <Textarea
                    label="Connection Code"
                    value={remoteConnectionCode}
                    onChange={(e) => setRemoteConnectionCode(e.target.value)}
                    placeholder="pane-remote://..."
                    rows={3}
                    fullWidth
                  />
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      {remoteImportResult && (
                        <p className={`text-xs ${
                          remoteImportResult.includes('failed') ? 'text-status-error' : 'text-status-success'
                        }`}>
                          {remoteImportResult}
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={handleImportRemoteConnectionCode}
                      disabled={remoteBusy || remoteConnectionCode.trim().length === 0}
                      loading={remoteBusy && remoteConnectionCode.trim().length > 0}
                      loadingText="Connecting"
                    >
                      Import & Connect
                    </Button>
                  </div>
                  {importTailscaleDnsFailure && renderTailscaleClientRecovery(importRecoveryProfile, remoteImportRecoveryError)}
                </div>
              </SettingsSection>

              <SettingsSection
                title="Saved Remote Profiles"
                description="Reconnect to a saved remote daemon or remove old profiles"
                icon={<FileText className="w-4 h-4" />}
                spacing="sm"
              >
                <div className="space-y-2">
                  {remoteDaemonConfig.client.profiles.length === 0 && (
                    <p className="text-sm text-text-tertiary italic">No remote profiles saved yet.</p>
                  )}


                  {remoteDaemonConfig.client.profiles.map((profile) => {
                    const isActive = remoteDaemonConfig.client.activeProfileId === profile.id;
                    return (
                      <div
                        key={profile.id}
                        className={`flex items-center justify-between gap-3 p-3 rounded-lg border ${
                          isActive ? 'bg-status-success/10 border-status-success/35' : 'bg-surface-secondary border-border-secondary'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary">
                            {profile.label}
                            {isActive && (
                              <span className="ml-2 text-xs text-status-success">connected</span>
                            )}
                          </p>
                          <p className="text-xs text-text-tertiary truncate">{profile.baseUrl}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant={isActive ? 'secondary' : 'primary'}
                            size="sm"
                            onClick={() => handleUseRemoteProfile(profile.id)}
                            disabled={remoteBusy || isActive}
                          >
                            {isActive ? 'Connected' : 'Connect'}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteRemoteProfile(profile.id)}
                            disabled={remoteBusy}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SettingsSection>

              <CollapsibleCard
                title="Advanced Remote Setup"
                subtitle="Host listener settings, manual token entry, and local pairing tools"
                icon={<Eye className="w-5 h-5" />}
                defaultExpanded={false}
              >
                <SettingsSection
                  title="Remote Host"
                  description="Controls the loopback HTTP/SSE listener for this machine when it acts as a daemon"
                  icon={<Eye className="w-4 h-4" />}
                >
                  <div className="space-y-3">
                    <Checkbox
                      label="Enable remote daemon listener"
                      checked={remoteHostConfigDraft.enabled}
                      onChange={(e) => setRemoteHostConfigDraft({
                        ...remoteHostConfigDraft,
                        enabled: e.target.checked,
                      })}
                    />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Input
                        label="Listen Host"
                        value={remoteHostConfigDraft.listenHost}
                        onChange={(e) => setRemoteHostConfigDraft({
                          ...remoteHostConfigDraft,
                          listenHost: e.target.value,
                        })}
                        placeholder="127.0.0.1"
                        fullWidth
                      />
                      <Input
                        label="Listen Port"
                        type="number"
                        value={String(remoteHostConfigDraft.listenPort)}
                        onChange={(e) => setRemoteHostConfigDraft({
                          ...remoteHostConfigDraft,
                          listenPort: Number.parseInt(e.target.value, 10) || 42137,
                        })}
                        placeholder="42137"
                        fullWidth
                      />
                    </div>
                    <Checkbox
                      label="Require pairing / saved bearer tokens"
                      checked={remoteHostConfigDraft.pairingRequired}
                      onChange={(e) => setRemoteHostConfigDraft({
                        ...remoteHostConfigDraft,
                        pairingRequired: e.target.checked,
                      })}
                    />
                    <Checkbox
                      label="Allow direct HTTP on loopback"
                      checked={remoteHostConfigDraft.allowInsecureHttpOnLoopback}
                      onChange={(e) => setRemoteHostConfigDraft({
                        ...remoteHostConfigDraft,
                        allowInsecureHttpOnLoopback: e.target.checked,
                      })}
                    />
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-xs text-text-tertiary">
                        Paired remote clients on this machine: {remoteDaemonConfig.host.clients.length}
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleSaveRemoteHostConfig}
                        disabled={remoteBusy}
                      >
                        Save Host Settings
                      </Button>
                    </div>
                  </div>
                </SettingsSection>

                <SettingsSection
                  title="Create Paired Connection"
                  description="Mint a remote token and save a matching client profile in one step"
                  icon={<Plus className="w-4 h-4" />}
                >
                  <div className="space-y-3">
                    <Input
                      label="Connection Label"
                      value={remotePairLabel}
                      onChange={(e) => setRemotePairLabel(e.target.value)}
                      placeholder="Mac mini in office"
                      fullWidth
                    />
                    <Input
                      label="Remote Base URL"
                      value={remotePairBaseUrl}
                      onChange={(e) => setRemotePairBaseUrl(e.target.value)}
                      placeholder="http://127.0.0.1:42137"
                      fullWidth
                    />
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleCreateRemoteConnectionPair}
                        disabled={remoteBusy || remotePairLabel.trim().length === 0 || remotePairBaseUrl.trim().length === 0}
                      >
                        Create Paired Profile
                      </Button>
                    </div>
                    {remoteCreatedToken && (
                      <div className="p-3 rounded-lg bg-surface-secondary border border-border-secondary space-y-2">
                        <p className="text-sm font-medium text-text-primary">Latest generated remote token</p>
                        <Textarea
                          value={remoteCreatedToken}
                          onChange={() => {}}
                          rows={2}
                          readOnly
                          fullWidth
                        />
                        <p className="text-xs text-text-tertiary">
                          Use this token when creating a matching remote profile on another client machine.
                        </p>
                      </div>
                    )}
                  </div>
                </SettingsSection>

                <SettingsSection
                  title="Save Existing Remote Profile"
                  description="Save a token minted on the host so this desktop client can connect from another machine"
                  icon={<Plus className="w-4 h-4" />}
                >
                  <div className="space-y-3">
                    <Input
                      label="Existing Profile Label"
                      value={remoteImportedProfileLabel}
                      onChange={(e) => setRemoteImportedProfileLabel(e.target.value)}
                      placeholder="Office Mac mini tunnel"
                      fullWidth
                    />
                    <Input
                      label="Existing Remote Base URL"
                      value={remoteImportedProfileBaseUrl}
                      onChange={(e) => setRemoteImportedProfileBaseUrl(e.target.value)}
                      placeholder="http://127.0.0.1:42137"
                      fullWidth
                    />
                    <Textarea
                      label="Existing Remote Token"
                      value={remoteImportedProfileToken}
                      onChange={(e) => setRemoteImportedProfileToken(e.target.value)}
                      placeholder="Paste the token generated on the host machine"
                      rows={2}
                      fullWidth
                    />
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleSaveRemoteProfile}
                        disabled={
                          remoteBusy ||
                          remoteImportedProfileLabel.trim().length === 0 ||
                          remoteImportedProfileBaseUrl.trim().length === 0 ||
                          remoteImportedProfileToken.trim().length === 0
                        }
                      >
                        Save Remote Profile
                      </Button>
                    </div>
                  </div>
                </SettingsSection>
              </CollapsibleCard>
            </CollapsibleCard>

            {/* TODO: Cloud VM - revisit when implementation is complete
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
            */}

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

                <div className="mt-4">
                  <Checkbox
                    label="Use isolated PTY host (experimental)"
                    checked={usePtyHost}
                    onChange={(e) => setUsePtyHost(e.target.checked)}
                  />
                  <p className="text-xs text-text-tertiary mt-1">
                    Run terminal processes in a separate utility process for better crash isolation and fixes for Claude Code v2.1.113+ on macOS. Requires app restart; existing terminals keep their current backend, and new terminals after restart use the selected PTY mode.
                  </p>
                  {usePtyHost !== initialUsePtyHost && (
                    <p className="text-xs text-status-warning mt-1">
                      Restart Pane for this change to take effect.
                    </p>
                  )}
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

              <SettingsSection
                title="Analytics"
                description="Help improve Pane by sharing usage data"
                icon={<BarChart3 className="w-4 h-4" />}
              >
                <Checkbox
                  label="Enable analytics tracking"
                  checked={analyticsEnabled}
                  onChange={(e) => setAnalyticsEnabled(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  Pane collects usage analytics to improve the product. No prompts, code, or file paths are collected. You can opt out at any time.
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


      </ModalBody>

      {/* Footer */}
      {(activeTab === 'general' || activeTab === 'notifications' || activeTab === 'shortcuts') && (
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
