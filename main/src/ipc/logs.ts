import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { getPaneEventSink } from '../core/runtime';
import { SessionManager } from '../services/sessionManager';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

// Store logs per session in memory
const sessionLogs = new Map<string, LogEntry[]>();

const DAEMON_LOG_CHANNELS = [
  'sessions:get-logs',
  'sessions:clear-logs',
  'sessions:add-log',
] as const;

function sendSessionLogEvent(sessionId: string, entry: LogEntry): void {
  getPaneEventSink().send('session-log', {
    sessionId,
    entry,
  });
}

function sendSessionLogsClearedEvent(sessionId: string): void {
  getPaneEventSink().send('session-logs-cleared', { sessionId });
}

export function setupLogHandlers(
  ipcMain: IpcMain,
  _sessionManager: SessionManager,
  commandRegistry: PaneCommandRegistry,
) {
  // Get logs for a session
  commandRegistry.register('sessions:get-logs', async (sessionId: string) => {
    try {
      const logs = sessionLogs.get(sessionId) || [];
      return { success: true, data: logs };
    } catch (error) {
      console.error('Failed to get logs:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to get logs' 
      };
    }
  });

  // Clear logs for a session
  commandRegistry.register('sessions:clear-logs', async (sessionId: string) => {
    try {
      sessionLogs.set(sessionId, []);
      sendSessionLogsClearedEvent(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to clear logs:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to clear logs' 
      };
    }
  });

  // Add a log entry
  commandRegistry.register('sessions:add-log', async (sessionId: string, entry: LogEntry) => {
    try {
      const logs = sessionLogs.get(sessionId) || [];
      logs.push(entry);
      sessionLogs.set(sessionId, logs);

      sendSessionLogEvent(sessionId, entry);
      return { success: true };
    } catch (error) {
      console.error('Failed to add log:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to add log' 
      };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_LOG_CHANNELS);
}

// Helper function to add a log from internal sources
export function addSessionLog(sessionId: string, level: LogEntry['level'], message: string, source?: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    source
  };
  
  const logs = sessionLogs.get(sessionId) || [];
  logs.push(entry);
  sessionLogs.set(sessionId, logs);

  sendSessionLogEvent(sessionId, entry);
}

// Helper to clean up logs when a session is deleted or when starting a new run
export function cleanupSessionLogs(sessionId: string) {
  sessionLogs.delete(sessionId);

  sendSessionLogsClearedEvent(sessionId);
}
