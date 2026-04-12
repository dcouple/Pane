import { useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useErrorStore } from '../stores/errorStore';
import { API } from '../utils/api';
import type { Session, SessionOutput, GitStatus } from '../types/session';

interface SessionEventData {
  sessionId: string;
  [key: string]: unknown;
}

type ValidatedEventData = SessionEventData | SessionOutput;

interface SessionDeletedEventData {
  id?: string;
  sessionId?: string;
}

// Frontend validation helpers
function validateEventSession(eventData: ValidatedEventData, activeSessionId?: string): boolean {
  if (!eventData || !eventData.sessionId) {
    console.warn('[useIPCEvents] Event missing sessionId:', eventData);
    return false;
  }
  
  // If we have an active session context, validate the event matches
  if (activeSessionId && eventData.sessionId !== activeSessionId) {
    console.warn(`[useIPCEvents] Event sessionId ${eventData.sessionId} does not match active session ${activeSessionId}`);
    return false;
  }
  
  return true;
}


// Throttle utility with external drain support
function createThrottledWithDrain<T extends (...args: Parameters<T>) => unknown>(
  fn: T,
  delayMs: number,
  keyFn: (...args: Parameters<T>) => string,
): {
  throttled: (...args: Parameters<T>) => void;
  drain: (sessionId: string) => void;
} {
  const pendingCalls = new Map<string, Parameters<T>>();
  let lastCallTime = 0;
  let timeoutId: NodeJS.Timeout | null = null;

  const throttled = (...args: Parameters<T>): void => {
    const now = Date.now();
    const key = keyFn(...args);
    pendingCalls.set(key, args);

    const delay = Math.max(0, delayMs - (now - lastCallTime));
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      lastCallTime = Date.now();
      for (const callArgs of pendingCalls.values()) {
        fn(...callArgs);
      }
      pendingCalls.clear();
      timeoutId = null;
    }, delay);
  };

  const drain = (sessionId: string): void => {
    pendingCalls.delete(sessionId);
  };

  return { throttled, drain };
}

export function useIPCEvents() {
  const { setSessions, loadSessions, addSession, updateSession, deleteSession } = useSessionStore();
  const { showError } = useErrorStore();
  
  // Create throttled handlers for git status events (with drain support)
  const gitStatusLoadingRef = useRef(
    createThrottledWithDrain(
      (data: { sessionId: string }) => {
        // Validate event has required session context
        if (!validateEventSession(data)) {
          return; // Ignore invalid events
        }
        useSessionStore.getState().setGitStatusLoading(data.sessionId, true);

        // Also emit a custom event for individual components to listen to
        window.dispatchEvent(new CustomEvent('git-status-loading', {
          detail: { sessionId: data.sessionId }
        }));
      },
      100,
      (data) => data.sessionId,
    )
  ).current;

  const gitStatusUpdatedRef = useRef(
    createThrottledWithDrain(
      (data: { sessionId: string; gitStatus: GitStatus }) => {
        // Validate event has required session context
        if (!validateEventSession(data)) {
          return; // Ignore invalid events
        }

        // Only log significant status changes in production
        if (data.gitStatus.state !== 'clean' || process.env.NODE_ENV === 'development') {
          console.log(`[useIPCEvents] Git status: ${data.sessionId.substring(0, 8)} → ${data.gitStatus.state}`);
        }

        // Update the store and clear loading state
        useSessionStore.getState().updateSessionGitStatus(data.sessionId, data.gitStatus);
        useSessionStore.getState().setGitStatusLoading(data.sessionId, false);

        // Also emit a custom event for individual components to listen to
        window.dispatchEvent(new CustomEvent('git-status-updated', {
          detail: { sessionId: data.sessionId, gitStatus: data.gitStatus }
        }));
      },
      100,
      (data) => data.sessionId,
    )
  ).current;
  
  useEffect(() => {
    // Check if we're in Electron environment
    if (!window.electronAPI) {
      console.warn('Electron API not available, events will not work');
      return;
    }

    // Set up IPC event listeners
    const unsubscribeFunctions: (() => void)[] = [];

    // Listen for session events
    const unsubscribeSessionCreated = window.electronAPI.events.onSessionCreated((session: Session) => {
      console.log('[useIPCEvents] Session created:', session.id);
      addSession({...session, output: session.output || [], jsonMessages: session.jsonMessages || []});
      // Set git status as loading for new sessions
      useSessionStore.getState().setGitStatusLoading(session.id, true);
    });
    unsubscribeFunctions.push(unsubscribeSessionCreated);

    const unsubscribeSessionUpdated = window.electronAPI.events.onSessionUpdated((session: Session) => {
      console.log('[useIPCEvents] Session updated event received:', {
        id: session.id,
        status: session.status
      });
      
      // Ensure we have valid session data
      if (!session || !session.id) {
        console.error('[useIPCEvents] Invalid session data received:', session);
        return;
      }
      
      // Update the session with initialized arrays
      const sessionWithArrays = {
        ...session,
        output: session.output || [],
        jsonMessages: session.jsonMessages || []
      };
      
      updateSession(sessionWithArrays);
      
      // Force a re-render if this is the active session and status changed to stopped
      const state = useSessionStore.getState();
      if (state.activeSessionId === session.id && 
          (session.status === 'stopped' || session.status === 'error')) {
        // Emit a custom event to trigger UI updates
        window.dispatchEvent(new CustomEvent('session-status-changed', { 
          detail: { sessionId: session.id, status: session.status } 
        }));
      }
    });
    unsubscribeFunctions.push(unsubscribeSessionUpdated);

    const unsubscribeSessionDeleted = window.electronAPI.events.onSessionDeleted((sessionData: SessionDeletedEventData | string) => {
      console.log('[useIPCEvents] Session deleted:', sessionData);
      // The backend sends just { id } for deleted sessions
      const sessionId = typeof sessionData === 'string' ? sessionData : sessionData.id || sessionData.sessionId;

      // Drain any pending throttled git status calls for this session
      if (sessionId) {
        gitStatusLoadingRef.drain(sessionId);
        gitStatusUpdatedRef.drain(sessionId);
      }

      // Dispatch a custom event for other components to listen to
      window.dispatchEvent(new CustomEvent('session-deleted', {
        detail: { id: sessionId }
      }));

      // Create a minimal session object for deletion
      deleteSession({ id: sessionId } as Session);
    });
    unsubscribeFunctions.push(unsubscribeSessionDeleted);

    const unsubscribeSessionsLoaded = window.electronAPI.events.onSessionsLoaded((sessions: Session[]) => {
      // Group logging for session loading
      const withStatus = sessions.filter(s => s.gitStatus).length;
      const withoutStatus = sessions.filter(s => !s.gitStatus).length;
      if (withoutStatus > 0) {
        console.log(`[useIPCEvents] Sessions: ${sessions.length} total (${withStatus} with status, ${withoutStatus} pending)`);
      } else {
        console.log(`[useIPCEvents] Sessions: ${sessions.length} loaded`);
      }
      
      const sessionsWithJsonMessages = sessions.map(session => ({
        ...session,
        jsonMessages: session.jsonMessages || []
      }));
      loadSessions(sessionsWithJsonMessages);
      // Set git status as loading for sessions without git status
      sessions.forEach(session => {
        if (!session.gitStatus && !session.archived) {
          useSessionStore.getState().setGitStatusLoading(session.id, true);
        }
      });
    });
    unsubscribeFunctions.push(unsubscribeSessionsLoaded);

    const unsubscribeSessionOutput = window.electronAPI.events.onSessionOutput((output: SessionOutput) => {
      // Validate event has required session context
      if (!validateEventSession(output)) {
        return; // Ignore invalid events
      }

      console.log(`[useIPCEvents] Received session output for ${output.sessionId}, type: ${output.type}`);

      // Just emit custom event to notify that new output is available
      // Include panelId (if present) so panel-based views can react precisely
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: output.sessionId, panelId: output.panelId }
      }));
    });
    unsubscribeFunctions.push(unsubscribeSessionOutput);

    const unsubscribeTerminalOutput = window.electronAPI.events.onTerminalOutput((output: { sessionId: string; type: 'stdout' | 'stderr'; data: string }) => {
      // Validate event has required session context
      if (!validateEventSession(output)) {
        return; // Ignore invalid events
      }

      console.log(`[useIPCEvents] Received terminal output for ${output.sessionId}`);
      // Store terminal output in session store for display
      useSessionStore.getState().addTerminalOutput(output);
    });
    unsubscribeFunctions.push(unsubscribeTerminalOutput);
    
    const unsubscribeOutputAvailable = window.electronAPI.events.onSessionOutputAvailable((info: { sessionId: string }) => {
      // Validate event has required session context
      if (!validateEventSession(info)) {
        return; // Ignore invalid events
      }

      console.log(`[useIPCEvents] Output available notification for session ${info.sessionId}`);
      
      // Emit custom event to notify that output is available
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: info.sessionId }
      }));
    });
    unsubscribeFunctions.push(unsubscribeOutputAvailable);
    
    // Listen for zombie process detection
    const unsubscribeZombieProcesses = window.electronAPI.events.onZombieProcessesDetected((data: { sessionId?: string | null; pids?: number[]; message: string }) => {
      console.error('[useIPCEvents] Zombie processes detected:', data);
      
      // Show error to user
      const errorMessage = data.message || 'Some child processes could not be terminated. Please check your system process list.';
      const details = data.pids && data.pids.length > 0 
        ? `Unable to terminate process IDs: ${data.pids.join(', ')}\n\nYou may need to manually kill these processes.`
        : undefined;
      
      showError({
        title: 'Zombie Processes Detected',
        error: errorMessage,
        details
      });
      
      // Also log PIDs if available
      if (data.pids && data.pids.length > 0) {
        console.error(`Zombie process PIDs: ${data.pids.join(', ')}`);
      }
    });
    unsubscribeFunctions.push(unsubscribeZombieProcesses);

    // Listen for git status updates (throttled)
    const unsubscribeGitStatusUpdated = window.electronAPI.events.onGitStatusUpdated(gitStatusUpdatedRef.throttled);
    unsubscribeFunctions.push(unsubscribeGitStatusUpdated);

    // Listen for git status loading events (throttled)
    const unsubscribeGitStatusLoading = window.electronAPI.events.onGitStatusLoading?.(gitStatusLoadingRef.throttled);
    if (unsubscribeGitStatusLoading) {
      unsubscribeFunctions.push(unsubscribeGitStatusLoading);
    }
    
    // Listen for batch git status events
    const unsubscribeGitStatusLoadingBatch = window.electronAPI.events.onGitStatusLoadingBatch?.((sessionIds: string[]) => {
      const state = useSessionStore.getState();
      const knownIds = new Set(state.sessions.map((s) => s.id));
      const filteredIds = sessionIds.filter((id) => knownIds.has(id));
      if (filteredIds.length > 0) {
        const updates = filteredIds.map(sessionId => ({ sessionId, loading: true }));
        state.setGitStatusLoadingBatch(updates);

        // Dispatch custom events for each session
        filteredIds.forEach(sessionId => {
          window.dispatchEvent(new CustomEvent('git-status-loading', {
            detail: { sessionId }
          }));
        });
      }
    });
    if (unsubscribeGitStatusLoadingBatch) {
      unsubscribeFunctions.push(unsubscribeGitStatusLoadingBatch);
    }

    const unsubscribeGitStatusUpdatedBatch = window.electronAPI.events.onGitStatusUpdatedBatch?.((updates: Array<{ sessionId: string; status: GitStatus }>) => {
      console.log(`[useIPCEvents] Git status batch update: ${updates.length} sessions`);
      const state = useSessionStore.getState();
      const knownIds = new Set(state.sessions.map((s) => s.id));
      const filtered = updates.filter((entry) => knownIds.has(entry.sessionId));
      if (filtered.length > 0) {
        state.updateSessionGitStatusBatch(filtered);

        // Dispatch custom events for each session
        filtered.forEach(({ sessionId, status }) => {
          window.dispatchEvent(new CustomEvent('git-status-updated', {
            detail: { sessionId, gitStatus: status }
          }));
        });
      }
    });
    if (unsubscribeGitStatusUpdatedBatch) {
      unsubscribeFunctions.push(unsubscribeGitStatusUpdatedBatch);
    }

    // Listen for spotlight events
    const unsubscribeSpotlightStatus = window.electronAPI.events.onSpotlightStatusChanged?.((data: { sessionId: string; projectId: number; active: boolean }) => {
      console.log(`[useIPCEvents] Spotlight status changed: session=${data.sessionId}, project=${data.projectId}, active=${data.active}`);
      useSessionStore.getState().setSpotlightActive(data.sessionId, data.projectId, data.active);
    });
    if (unsubscribeSpotlightStatus) {
      unsubscribeFunctions.push(unsubscribeSpotlightStatus);
    }

    const unsubscribeSpotlightError = window.electronAPI.events.onSpotlightSyncError?.((data: { sessionId: string; projectId: number; error: string }) => {
      console.error(`[useIPCEvents] Spotlight sync error for session ${data.sessionId}:`, data.error);
      // Show error via existing error store
      showError({
        title: 'Spotlight Sync Error',
        error: data.error,
        details: `Session: ${data.sessionId}`
      });
    });
    if (unsubscribeSpotlightError) {
      unsubscribeFunctions.push(unsubscribeSpotlightError);
    }

    const unsubscribeSpotlightTamper = window.electronAPI.events.onSpotlightTamperDetected?.((data: { sessionId: string; projectId: number; message: string }) => {
      console.warn(`[useIPCEvents] Spotlight tamper detected for session ${data.sessionId}:`, data.message);
      showError({
        title: 'Spotlight Disabled',
        error: data.message,
        details: `The spotlight was automatically disabled because the repository root was modified externally.`
      });
    });
    if (unsubscribeSpotlightTamper) {
      unsubscribeFunctions.push(unsubscribeSpotlightTamper);
    }

    // Load initial sessions
    API.sessions.getAll()
      .then(response => {
        if (response.success && response.data) {
          const sessionsWithJsonMessages = response.data.map((session: Session) => ({
            ...session,
            jsonMessages: session.jsonMessages || []
          }));
          loadSessions(sessionsWithJsonMessages);
        }
      })
      .catch(error => {
        console.error('Failed to load initial sessions:', error);
      });

    return () => {
      // Clean up all event listeners
      unsubscribeFunctions.forEach(unsubscribe => unsubscribe());
    };
  }, [setSessions, loadSessions, addSession, updateSession, deleteSession, showError]);
  
  // Return a mock socket object for compatibility
  return {
    connected: true,
    disconnect: () => {},
  };
}
