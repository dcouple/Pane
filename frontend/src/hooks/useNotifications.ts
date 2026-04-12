import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { usePanelStore } from '../stores/panelStore';
import { API } from '../utils/api';
import { ToolPanel } from '../../../shared/types/panels';

// Extend window interface for webkit audio context compatibility
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

interface NotificationSettings {
  playSound: boolean;
  notifyWhenBackgrounded: boolean;
  notifyWhenViewingOtherPanel: boolean;
}

// Extra delay on top of the 5s PTY idle threshold before firing a "finished"
// notification. Guards against false positives from mid-task pauses: network
// waits, slow tool calls, shells sitting between commands. Total silent time
// before a notification fires is roughly 5s (dot flip) + 25s = 30s.
const NOTIFICATION_DEBOUNCE_MS = 25_000;

export function useNotifications() {
  const [settings, setSettings] = useState<NotificationSettings>({
    playSound: true,
    notifyWhenBackgrounded: true,
    notifyWhenViewingOtherPanel: false,
  });
  const settingsLoaded = useRef(false);

  // Mirror settings into a ref so the Zustand subscription callback reads the
  // latest value without needing to re-subscribe every time a toggle changes.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Track previous activityStatus per panelId to detect active -> idle transitions.
  const prevActivityRef = useRef<Record<string, 'active' | 'idle'>>({});

  // Pending notification timers per panelId. A panel must stay idle for
  // NOTIFICATION_DEBOUNCE_MS after the 5s dot flip before we fire, so we
  // don't ping on mid-task pauses (network waits, slow tool calls, shells
  // sitting at a prompt between commands). Re-activation cancels the timer.
  const pendingIdleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Project name cache keyed by project id, refreshed on mount and on project changes.
  const projectNamesRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    const loadProjects = async () => {
      const res = await API.projects.getAll();
      if (res.success && res.data) {
        projectNamesRef.current = new Map(
          (res.data as { id: number; name: string }[]).map((p) => [p.id, p.name])
        );
      }
    };
    loadProjects();
    window.addEventListener('project-changed', loadProjects);
    return () => window.removeEventListener('project-changed', loadProjects);
  }, []);

  const requestPermission = async (): Promise<boolean> => {
    if (!('Notification' in window)) {
      console.warn('This browser does not support notifications');
      return false;
    }

    if (Notification.permission === 'granted') {
      return true;
    }

    if (Notification.permission === 'denied') {
      return false;
    }

    const permission = await Notification.requestPermission();
    return permission === 'granted';
  };

  const playNotificationSound = () => {
    if (!settingsRef.current.playSound) return;

    try {
      // Create a simple notification sound using Web Audio API
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        console.warn('AudioContext not supported');
        return;
      }
      const audioContext = new AudioContextClass();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(600, audioContext.currentTime + 0.1);

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
    } catch (error) {
      console.warn('Could not play notification sound:', error);
    }
  };

  // showNotification fires unconditionally so that the two direct callers in
  // App.tsx (unclean-shutdown and version-update) always work. Activity gating
  // lives only inside maybeNotifyPanelIdle.
  const showNotification = (
    title: string,
    body: string,
    icon?: string,
    _triggerEvent?: string,
    _trackingKey?: string,
  ) => {
    requestPermission().then((hasPermission) => {
      if (hasPermission) {
        new Notification(title, {
          body,
          icon: icon || '/favicon.ico',
          badge: '/favicon.ico',
          tag: 'claude-code-commander',
          requireInteraction: false,
        });

        playNotificationSound();
      }
    });
  };

  function maybeNotifyPanelIdle(panelId: string) {
    const currentSettings = settingsRef.current;
    if (!currentSettings.notifyWhenBackgrounded && !currentSettings.notifyWhenViewingOtherPanel) return;

    const panelStoreState = usePanelStore.getState();
    const sessionStoreState = useSessionStore.getState();

    let foundSessionId: string | undefined;
    let foundPanel: ToolPanel | undefined;
    for (const [sessionId, panels] of Object.entries(panelStoreState.panels)) {
      const panel = panels.find((p) => p.id === panelId);
      if (panel) {
        foundSessionId = sessionId;
        foundPanel = panel;
        break;
      }
    }
    if (!foundSessionId || !foundPanel) return;

    const session = sessionStoreState.sessions.find((s) => s.id === foundSessionId);
    if (!session) return;

    const windowFocused = document.hasFocus();
    const activeSessionId = sessionStoreState.activeSessionId;
    const activePanelId = panelStoreState.activePanels[foundSessionId];

    const userIsViewingThisPanel =
      windowFocused &&
      activeSessionId === foundSessionId &&
      activePanelId === panelId;

    if (userIsViewingThisPanel) return;

    const shouldFire =
      (currentSettings.notifyWhenBackgrounded && !windowFocused) ||
      (currentSettings.notifyWhenViewingOtherPanel && windowFocused && !userIsViewingThisPanel);

    if (!shouldFire) return;

    const projectName = session.projectId
      ? projectNamesRef.current.get(session.projectId) ?? ''
      : '';
    const panelName = foundPanel.title || 'Terminal';

    showNotification(
      `${panelName} finished`,
      projectName ? `${session.name} · ${projectName}` : session.name,
      undefined,
      'panel_idle',
      `idle:${panelId}:${Date.now()}`,
    );
  }

  // Subscribe to panelStore.activityStatus and schedule notifications on
  // active -> idle transitions, firing only after the panel has stayed idle
  // for NOTIFICATION_DEBOUNCE_MS. Re-activation cancels the pending timer,
  // so mid-task pauses never produce false "finished" pings.
  // Uses the unary subscribe form since panelStore does not use the
  // subscribeWithSelector middleware.
  useEffect(() => {
    const pending = pendingIdleTimersRef.current;
    // Seed from current store state so panels already active at mount time
    // (e.g. restored terminals, agents still running during app startup) are
    // correctly detected on their first idle transition instead of being
    // dismissed as `undefined -> idle`.
    prevActivityRef.current = { ...usePanelStore.getState().activityStatus };
    const unsubscribe = usePanelStore.subscribe((state) => {
      const activityStatus = state.activityStatus;
      const prev = prevActivityRef.current;
      for (const [panelId, status] of Object.entries(activityStatus)) {
        const prevStatus = prev[panelId];
        if (prevStatus === 'active' && status === 'idle') {
          // Schedule a debounced notification. Clear any stale timer first.
          const existing = pending.get(panelId);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            pending.delete(panelId);
            maybeNotifyPanelIdle(panelId);
          }, NOTIFICATION_DEBOUNCE_MS);
          pending.set(panelId, timer);
        } else if (prevStatus === 'idle' && status === 'active') {
          // Panel woke up before the debounce fired: cancel the pending notification.
          const existing = pending.get(panelId);
          if (existing) {
            clearTimeout(existing);
            pending.delete(panelId);
          }
        }
      }
      // Clean up timers for panels that have been removed from the store.
      for (const panelId of pending.keys()) {
        if (!(panelId in activityStatus)) {
          const existing = pending.get(panelId);
          if (existing) clearTimeout(existing);
          pending.delete(panelId);
        }
      }
      prevActivityRef.current = { ...activityStatus };
    });
    return () => {
      unsubscribe();
      // Clear all pending timers on unmount.
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscription must be created once; maybeNotifyPanelIdle reads live state via refs
  }, []);

  // Load settings on first mount
  useEffect(() => {
    if (!settingsLoaded.current) {
      settingsLoaded.current = true;

      API.config.get().then((response) => {
        if (response.success && response.data?.notifications) {
          setSettings(response.data.notifications);
        }
      }).catch((error) => {
        console.error('Failed to load notification settings:', error);
      });

      requestPermission();
    }
  }, []);

  return {
    settings,
    updateSettings: (newSettings: Partial<NotificationSettings>) => {
      setSettings((prev) => ({ ...prev, ...newSettings }));
    },
    requestPermission,
    showNotification,
  };
}
