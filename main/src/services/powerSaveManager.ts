import { powerSaveBlocker } from 'electron';
import type { EventEmitter } from 'events';
import type { AppConfig } from '../types/config';
import type { Session } from '../types/session';

const ACTIVE_SESSION_STATUSES = new Set<Session['status']>([
  'initializing',
  'ready',
  'running',
  'waiting',
]);

interface PowerSaveConfigSource extends EventEmitter {
  getConfig(): AppConfig;
}

interface PowerSaveSessionSource extends EventEmitter {
  getPowerSaveSnapshotSessions(): Session[];
}

interface PowerSaveBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

export class PowerSaveManager {
  private readonly activeSessionIds = new Set<string>();
  private blockerId: number | null = null;

  private readonly handleSessionsLoaded = (sessions: Session[]): void => {
    for (const session of sessions) {
      this.retainIfActive(session);
    }
    this.sync();
  };

  private readonly handleSessionChanged = (session: Session): void => {
    this.retainIfActive(session);
    this.sync();
  };

  private readonly handleSessionDeleted = (session: Pick<Session, 'id'>): void => {
    this.activeSessionIds.delete(session.id);
    this.sync();
  };

  private readonly handleConfigUpdated = (): void => {
    this.sync();
  };

  constructor(
    private readonly configManager: PowerSaveConfigSource,
    private readonly sessionManager: PowerSaveSessionSource,
    private readonly blocker: PowerSaveBlocker = powerSaveBlocker,
  ) {
    this.sessionManager.on('sessions-loaded', this.handleSessionsLoaded);
    this.sessionManager.on('session-created', this.handleSessionChanged);
    this.sessionManager.on('session-updated', this.handleSessionChanged);
    this.sessionManager.on('session-deleted', this.handleSessionDeleted);
    this.configManager.on('config-updated', this.handleConfigUpdated);

    for (const session of this.sessionManager.getPowerSaveSnapshotSessions()) {
      this.retainIfActive(session);
    }
  }

  sync(): void {
    const enabled = this.configManager.getConfig().keepAwakeWhileSessionsActive !== false;
    const hasActiveSession = this.activeSessionIds.size > 0;
    const shouldBlockSleep = enabled && hasActiveSession;

    if (shouldBlockSleep && this.blockerId === null) {
      this.blockerId = this.blocker.start('prevent-app-suspension');
    } else if (!shouldBlockSleep && this.blockerId !== null) {
      this.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }

  private retainIfActive(session: Session): void {
    if (!session.archived && ACTIVE_SESSION_STATUSES.has(session.status)) {
      this.activeSessionIds.add(session.id);
      return;
    }

    this.activeSessionIds.delete(session.id);
  }

  dispose(): void {
    this.sessionManager.removeListener('sessions-loaded', this.handleSessionsLoaded);
    this.sessionManager.removeListener('session-created', this.handleSessionChanged);
    this.sessionManager.removeListener('session-updated', this.handleSessionChanged);
    this.sessionManager.removeListener('session-deleted', this.handleSessionDeleted);
    this.configManager.removeListener('config-updated', this.handleConfigUpdated);

    if (this.blockerId !== null) {
      this.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }
}
