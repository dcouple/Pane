import { useState, useEffect, useMemo } from 'react';
import { useIPCEvents } from './hooks/useIPCEvents';
import { useNotifications } from './hooks/useNotifications';
import { useResizable } from './hooks/useResizable';
import { useHotkey } from './hooks/useHotkey';
import { useTerminalShortcuts } from './hooks/useTerminalShortcuts';
import { useShortcutHintsOverlay } from './hooks/useShortcutHintsOverlay';
import { ShortcutHintsOverlay } from './components/ShortcutHintsOverlay';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import Help from './components/Help';
import Welcome from './components/Welcome';
import AnalyticsConsentDialog from './components/AnalyticsConsentDialog';
import { AboutDialog } from './components/AboutDialog';
import { UpdateDialog } from './components/UpdateDialog';
import { MainProcessLogger } from './components/MainProcessLogger';
import { ErrorDialog } from './components/ErrorDialog';
import { PermissionDialog } from './components/PermissionDialog';
import { DiscordPopup } from './components/DiscordPopup';
import { ResumeSessionsDialog } from './components/ResumeSessionsDialog';
import { useErrorStore } from './stores/errorStore';
import { useSessionStore } from './stores/sessionStore';
import { useConfigStore } from './stores/configStore';
import { API } from './utils/api';
import { createVisibilityAwareInterval } from './utils/performanceUtils';
import { ContextMenuProvider } from './contexts/ContextMenuContext';
import { TokenTest } from './components/TokenTest';
import { CommandPalette } from './components/CommandPalette';
import { CloudOverlay } from './components/CloudOverlay';
import { CloudWidget } from './components/CloudWidget';
import { CreateSessionDialog } from './components/CreateSessionDialog';
import { AddProjectDialog } from './components/AddProjectDialog';
import { useNavigationStore } from './stores/navigationStore';
import { initPostHog, capture, posthog } from './services/posthog';
import type { VersionUpdateInfo, PermissionInput } from './types/session';
import type { TerminalShortcut } from './types/config';
import type { ResumableSession } from '../../shared/types/panels';
import type { Project } from './types/project';
import { isMac } from './utils/platformUtils';

// Stable empty array to avoid creating new references in render
const EMPTY_TERMINAL_SHORTCUTS: TerminalShortcut[] = [];

// Type for IPC response
interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: PermissionInput;
  timestamp: number;
}

function App() {
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(false);
  const [isAnalyticsConsentOpen, setIsAnalyticsConsentOpen] = useState(false);
  const [hasCheckedAnalyticsConsent, setHasCheckedAnalyticsConsent] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [updateVersionInfo, setUpdateVersionInfo] = useState<VersionUpdateInfo | null>(null);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);
  const [isDiscordOpen, setIsDiscordOpen] = useState(false);
  const [hasCheckedWelcome, setHasCheckedWelcome] = useState(false);
  const [isTokenTestOpen, setIsTokenTestOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [resumableSessions, setResumableSessions] = useState<ResumableSession[]>([]);
  const [isResumeDialogOpen, setIsResumeDialogOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>();
  const [showCreateSessionDialog, setShowCreateSessionDialog] = useState(false);
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const activeProjectId = useNavigationStore(s => s.activeProjectId);
  const { currentError, clearError } = useErrorStore();
  const { sessions, isLoaded } = useSessionStore();
  const { fetchConfig, config: appConfig } = useConfigStore();
  const terminalShortcuts = appConfig?.terminalShortcuts ?? EMPTY_TERMINAL_SHORTCUTS;
  const { isVisible: shortcutHintsVisible } = useShortcutHintsOverlay();
  
  const { width: sidebarWidth, startResize } = useResizable({
    defaultWidth: 352,
    minWidth: 200,
    maxWidth: 500,
    storageKey: 'pane-sidebar-width'
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('pane-sidebar-collapsed') === 'true';
  });
  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('pane-sidebar-collapsed', String(next));
      return next;
    });
  };
  
  useIPCEvents();
  const { showNotification } = useNotifications();

  // Keyboard shortcuts
  useHotkey({
    id: 'toggle-token-test',
    label: 'Toggle Token Test Page',
    keys: 'mod+shift+t',
    category: 'debug',
    devOnly: true,
    action: () => setIsTokenTestOpen(prev => !prev),
  });

  useHotkey({
    id: 'open-command-palette',
    label: 'Open Command Palette',
    keys: 'mod+k',
    category: 'navigation',
    action: () => setIsCommandPaletteOpen(true),
  });

  useHotkey({
    id: 'toggle-sidebar',
    label: 'Toggle Sidebar',
    keys: 'mod+b',
    category: 'view',
    action: toggleSidebarCollapsed,
  });

  useHotkey({
    id: 'open-settings',
    label: 'Open Settings',
    keys: 'mod+,',
    category: 'navigation',
    action: () => setIsSettingsOpen(true),
  });

  useHotkey({
    id: 'focus-sidebar',
    label: 'Focus Sidebar',
    keys: 'mod+shift+e',
    category: 'navigation',
    action: () => {
      if (sidebarCollapsed) toggleSidebarCollapsed();
    },
  });

  useHotkey({
    id: 'open-shortcut-settings',
    label: 'Open Shortcut Settings',
    keys: 'mod+alt+/',
    category: 'shortcuts',
    action: () => {
      setSettingsInitialSection('terminal-shortcuts');
      setIsSettingsOpen(true);
    },
  });

  useHotkey({
    id: 'new-session',
    label: 'New Pane',
    keys: 'mod+n',
    category: 'session',
    action: () => {
      if (activeProject) setShowCreateSessionDialog(true);
    },
  });

  useHotkey({
    id: 'new-project',
    label: 'New Project',
    keys: 'mod+shift+n',
    category: 'navigation',
    action: () => setShowAddProjectDialog(true),
  });

  // Register terminal shortcuts (hotkey-triggered clipboard paste)
  useTerminalShortcuts();

  // Load config on app startup
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Fetch projects for global shortcuts
  useEffect(() => {
    const fetchProjects = async () => {
      const res = await API.projects.getAll();
      if (res.success && res.data) setProjects(res.data);
    };
    fetchProjects();
    const handle = () => fetchProjects();
    window.addEventListener('project-changed', handle);
    window.addEventListener('project-sessions-refresh', handle);
    return () => {
      window.removeEventListener('project-changed', handle);
      window.removeEventListener('project-sessions-refresh', handle);
    };
  }, []);

  const activeProject = useMemo(() => {
    if (activeProjectId) return projects.find(p => p.id === activeProjectId);
    return projects.find(p => p.active) || projects[0];
  }, [projects, activeProjectId]);

  // Check if analytics consent dialog should be shown (before other dialogs)
  useEffect(() => {
    if (hasCheckedAnalyticsConsent) {
      return;
    }

    const checkAnalyticsConsent = async () => {
      if (!window.electron?.invoke) {
        return;
      }

      try {
        // Check if consent has already been shown
        const consentResult = await window.electron.invoke('preferences:get', 'analytics_consent_shown') as IPCResponse<string>;
        const hasShownConsent = consentResult?.data === 'true';

        if (!hasShownConsent) {
          // Show consent dialog
          setIsAnalyticsConsentOpen(true);
        }
      } catch (error) {
        console.error('[App] Error checking analytics consent:', error);
      }
    };

    setHasCheckedAnalyticsConsent(true);
    checkAnalyticsConsent();
  }, [hasCheckedAnalyticsConsent]);

  // Initialize PostHog after config loads, then start forwarding main-process events.
  // Both must live in the same effect so buffered events aren't replayed before init.
  useEffect(() => {
    if (!appConfig) return;
    initPostHog({
      enabled: appConfig.analytics?.enabled ?? false,
      posthogApiKey: appConfig.analytics?.posthogApiKey,
      posthogHost: appConfig.analytics?.posthogHost,
    });
    // Sync distinct ID to main process so shutdown analytics use the same identity
    const distinctId = posthog.get_distinct_id();
    if (distinctId) {
      window.electronAPI?.analytics?.syncDistinctId(distinctId);
    }
    // Now that PostHog is initialized, register the IPC listener.
    // The preload buffers any events that arrived before this point and replays them.
    if (!window.electronAPI?.analytics?.onMainEvent) return;
    const cleanup = window.electronAPI.analytics.onMainEvent((event) => {
      capture(event.eventName, event.properties);
    });
    return cleanup;
  }, [appConfig]);

  // CRITICAL PERFORMANCE FIX: Cleanup to prevent V8 array iteration issues
  // Uses visibility-aware interval: 60s when active, 600s when hidden
  useEffect(() => {
    const runCleanup = () => {
      const store = useSessionStore.getState();
      if (store.sessions.length > 0) {
        store.cleanupInactiveSessions();
      }
    };

    const cleanupDispose = createVisibilityAwareInterval(runCleanup, 60 * 1000);

    // Immediate cleanup when switching sessions
    const handleSessionSwitch = () => runCleanup();
    window.addEventListener('session-switched', handleSessionSwitch);

    // Pause animations when window is hidden to save battery
    const handleVisibilityChange = () => {
      document.documentElement.classList.toggle('window-hidden', document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cleanupDispose();
      window.removeEventListener('session-switched', handleSessionSwitch);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    // Show welcome screen and Discord popup intelligently based on user state
    // This should only run once when the app is loaded, not when sessions change
    // Don't show welcome while analytics consent dialog is open
    if (!isLoaded || hasCheckedWelcome || isAnalyticsConsentOpen) {
      return;
    }

    const checkInitialState = async () => {
      if (!window.electron?.invoke) {
        return;
      }

      // Get preferences from database
      const hideWelcomeResult = await window.electron.invoke('preferences:get', 'hide_welcome') as IPCResponse<string>;
      const welcomeShownResult = await window.electron.invoke('preferences:get', 'welcome_shown') as IPCResponse<string>;
      const hideDiscordResult = await window.electron.invoke('preferences:get', 'hide_discord') as IPCResponse<string>;
      
      const hideWelcome = hideWelcomeResult?.data === 'true';
      const hasSeenWelcome = welcomeShownResult?.data === 'true';
      const hideDiscord = hideDiscordResult?.data === 'true';
      
      
      // Track whether we're showing the welcome screen
      let welcomeScreenShown = false;
      
      // If user explicitly said "don't show again", respect that preference
      if (hideWelcome) {
        welcomeScreenShown = false;
      } else {
        try {
          const projectsResponse = await API.projects.getAll();
          const hasProjects = projectsResponse.success && projectsResponse.data && projectsResponse.data.length > 0;
          // Get sessions from the API to avoid stale closure
          const sessionsResponse = await API.sessions.getAll();
          const hasSessions = sessionsResponse.success && sessionsResponse.data && sessionsResponse.data.length > 0;
          
          // Show welcome if:
          // 1. First time user (no projects and never seen welcome)
          // 2. Returning user with no active data (no projects and no sessions)
          const isFirstTimeUser = !hasProjects && !hasSeenWelcome;
          const isReturningUserWithNoData = !hasProjects && !hasSessions && hasSeenWelcome;
          
          
          if (isFirstTimeUser || isReturningUserWithNoData) {
            setIsWelcomeOpen(true);
            welcomeScreenShown = true;
            // Mark that welcome has been shown at least once
            await window.electron.invoke('preferences:set', 'welcome_shown', 'true');
          } else {
            welcomeScreenShown = false;
          }
        } catch (error) {
          console.error('Error checking initial state:', error);
          welcomeScreenShown = false;
        }
      }
      
      // If welcome screen is not shown and Discord hasn't been hidden, check if we should show Discord popup
      if (!welcomeScreenShown && !hideDiscord) {
        
        try {
          // Get the last app open to see if Discord was already shown
          const result = await window.electron.invoke('app:get-last-open') as IPCResponse<{ discord_shown?: boolean }>;
          
          if (result?.success && result.data) {
            const lastOpen = result.data;
            
            // Show Discord popup if it hasn't been shown yet
            if (!lastOpen.discord_shown) {
              setIsDiscordOpen(true);
              // Mark that we're showing the Discord popup
              if (window.electron?.invoke) {
                await window.electron.invoke('app:update-discord-shown');
              }
            } else {
              // Discord already shown
            }
          } else {
            // No previous app open - show Discord popup
            setIsDiscordOpen(true);
            // Will update discord shown status after recording app open
          }
        } catch (error) {
          // Error checking Discord popup
        }
        
        // Record this app open
        if (window.electron?.invoke) {
          await window.electron.invoke('app:record-open', hideWelcome, false);
          
          // If we showed Discord popup and there was no previous app open, update the status
          const result = await window.electron.invoke('app:get-last-open') as IPCResponse<{ discord_shown?: boolean }>;
          if (!result?.data?.discord_shown && isDiscordOpen) {
            await window.electron.invoke('app:update-discord-shown');
          }
        }
      }
    };
    
    // Set the flag first to prevent re-runs
    setHasCheckedWelcome(true);
    checkInitialState();
  }, [isLoaded, isAnalyticsConsentOpen]); // Also wait for analytics consent dialog to close

  // Discord popup logic is now combined with welcome screen logic above

  // Check for resumable sessions on startup (auto-resume feature)
  useEffect(() => {
    if (!isLoaded || isAnalyticsConsentOpen) return;

    const checkResumableSessions = async () => {
      try {
        const result = await window.electronAPI.sessions.getResumable();
        if (result.success && result.data && Array.isArray(result.data) && result.data.length > 0) {
          setResumableSessions(result.data as ResumableSession[]);
          setIsResumeDialogOpen(true);
        }
      } catch (error) {
        console.error('[App] Failed to check for resumable sessions:', error);
      }
    };

    checkResumableSessions();
  }, [isLoaded, isAnalyticsConsentOpen]);

  useEffect(() => {
    // Set up permission request listener
    const handlePermissionRequest = (...args: unknown[]) => {
      const request = args[0] as PermissionRequest;
      setCurrentPermissionRequest(request);
    };

    window.electron?.on('permission:request', handlePermissionRequest);

    return () => {
      window.electron?.off('permission:request', handlePermissionRequest);
    };
  }, []);

  useEffect(() => {
    // Set up version update listener
    if (!window.electronAPI?.events) return;
    
    const handleVersionUpdate = (versionInfo: VersionUpdateInfo) => {
      console.log('[App] Version update available:', versionInfo);
      setUpdateVersionInfo(versionInfo);
      setIsUpdateDialogOpen(true);
      showNotification(
        `🚀 Update Available - Pane v${versionInfo.latest}`,
        'A new version of Pane is available!',
        '/favicon.ico',
        'version_update',
        `update:${versionInfo.latest}` // Deduplicate by version - only track once per version
      );
    };
    
    // Set up the listener using the events API
    const removeListener = window.electronAPI.events.onVersionUpdateAvailable(handleVersionUpdate);
    
    return () => {
      if (removeListener) {
        removeListener();
      }
    };
  }, [showNotification]);

  const handleAboutUpdate = (versionInfo: { current: string; latest: string; hasUpdate: boolean; releaseUrl?: string; releaseNotes?: string }) => {
    setUpdateVersionInfo({
      ...versionInfo,
      version: versionInfo.latest,
    });
    setIsAboutOpen(false);
    setIsUpdateDialogOpen(true);
  };

  const handlePermissionResponse = async (requestId: string, behavior: 'allow' | 'deny', _updatedInput?: PermissionInput, message?: string) => {
    try {
      await API.permissions.respond(requestId, {
        allow: behavior === 'allow',
        reason: message
      });
      setCurrentPermissionRequest(null);
    } catch (error) {
      console.error('Failed to respond to permission request:', error);
    }
  };

  return (
    <ContextMenuProvider>
      <div className="h-screen flex flex-col overflow-hidden bg-bg-primary">
        {isMac() && (
          <div
            className="flex-shrink-0 bg-bg-primary"
            style={{ height: 38, WebkitAppRegion: 'drag' } as React.CSSProperties}
          />
        )}
        <div className="flex flex-1 min-h-0">
        <MainProcessLogger />
        <Sidebar
          onHelpClick={() => setIsHelpOpen(true)}
          onAboutClick={() => setIsAboutOpen(true)}
          onSettingsClick={() => setIsSettingsOpen(true)}
          isSettingsOpen={isSettingsOpen}
          onSettingsClose={() => { setIsSettingsOpen(false); setSettingsInitialSection(undefined); }}
          settingsInitialSection={settingsInitialSection}
          width={sidebarWidth}
          onResize={startResize}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebarCollapsed}
        />
        <SessionView />
        <CloudOverlay />
        <CloudWidget />
        <Help isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
        <AnalyticsConsentDialog
          isOpen={isAnalyticsConsentOpen}
          onClose={() => setIsAnalyticsConsentOpen(false)}
        />
        <Welcome isOpen={isWelcomeOpen} onClose={() => setIsWelcomeOpen(false)} />
        <AboutDialog isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} onUpdate={handleAboutUpdate} />
        <UpdateDialog 
          isOpen={isUpdateDialogOpen} 
          onClose={() => setIsUpdateDialogOpen(false)}
          versionInfo={updateVersionInfo || undefined}
        />
        <ErrorDialog 
          isOpen={!!currentError}
          onClose={clearError}
          title={currentError?.title}
          error={currentError?.error || ''}
          details={currentError?.details}
          command={currentError?.command}
        />
        <PermissionDialog
          request={currentPermissionRequest}
          onRespond={handlePermissionResponse}
          session={currentPermissionRequest ? sessions.find(s => s.id === currentPermissionRequest.sessionId) : undefined}
        />
        <DiscordPopup
          isOpen={isDiscordOpen}
          onClose={() => setIsDiscordOpen(false)}
        />
        <ResumeSessionsDialog
          isOpen={isResumeDialogOpen}
          onClose={() => setIsResumeDialogOpen(false)}
          sessions={resumableSessions}
        />
        <CommandPalette
          isOpen={isCommandPaletteOpen}
          onClose={() => setIsCommandPaletteOpen(false)}
        />
        {showCreateSessionDialog && activeProject && (
          <CreateSessionDialog
            isOpen={showCreateSessionDialog}
            onClose={() => setShowCreateSessionDialog(false)}
            projectName={activeProject.name}
            projectId={activeProject.id}
          />
        )}
        <AddProjectDialog
          isOpen={showAddProjectDialog}
          onClose={() => setShowAddProjectDialog(false)}
        />
        <ShortcutHintsOverlay isVisible={shortcutHintsVisible} shortcuts={terminalShortcuts} />

        {/* Token Test Modal - Toggle with Cmd/Ctrl + Shift + T (Development Only) */}
        {isTokenTestOpen && process.env.NODE_ENV === 'development' && (
          <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50 p-4 overflow-y-auto">
            <div className="bg-bg-primary w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded-lg relative border border-border-primary shadow-2xl">
              <button
                onClick={() => setIsTokenTestOpen(false)}
                className="absolute top-4 right-4 p-2 hover:bg-surface-hover rounded-lg transition-colors text-text-secondary hover:text-text-primary"
                title="Close Token Test (Cmd/Ctrl + Shift + T)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div className="absolute top-4 left-4 text-xs text-text-muted bg-surface-secondary px-2 py-1 rounded">
                DEV ONLY
              </div>
              <TokenTest />
            </div>
          </div>
        )}
        </div>
      </div>
    </ContextMenuProvider>
  );
}

export default App;