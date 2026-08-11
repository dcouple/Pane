import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/config';
import type { Session } from '../types/session';

const powerSaveBlocker = vi.hoisted(() => ({
  start: vi.fn(() => 42),
  stop: vi.fn(),
  isStarted: vi.fn(() => true),
}));

vi.mock('electron', () => ({ powerSaveBlocker }));

import { ConfigManager } from './configManager';
import { PowerSaveManager } from './powerSaveManager';

class ConfigManagerStub extends EventEmitter {
  private config: AppConfig = { keepAwakeWhileSessionsActive: true };

  getConfig(): AppConfig {
    return { ...this.config };
  }

  setKeepAwake(enabled: boolean): void {
    this.config = { ...this.config, keepAwakeWhileSessionsActive: enabled };
    this.emit('config-updated', this.getConfig());
  }
}

class SessionManagerStub extends EventEmitter {
  constructor(private readonly snapshotSessions: Session[] = []) {
    super();
  }

  getPowerSaveSnapshotSessions(): Session[] {
    return this.snapshotSessions;
  }
}

function createSession(
  id: string,
  status: Session['status'],
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    name: id,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status,
    createdAt: new Date(),
    output: [],
    jsonMessages: [],
    ...overrides,
  };
}

describe('PowerSaveManager', () => {
  let configManager: ConfigManagerStub;
  let sessionManager: SessionManagerStub;
  let manager: PowerSaveManager;

  beforeEach(() => {
    powerSaveBlocker.start.mockClear();
    powerSaveBlocker.stop.mockClear();
    powerSaveBlocker.isStarted.mockClear();
    configManager = new ConfigManagerStub();
    sessionManager = new SessionManagerStub();
    manager = new PowerSaveManager(configManager, sessionManager);
  });

  afterEach(() => {
    manager.dispose();
  });

  it.each<Session['status']>(['initializing', 'ready', 'running', 'waiting'])(
    'starts exactly one app-suspension blocker for an active %s session',
    status => {
      sessionManager.emit('session-created', createSession('session-1', status));
      sessionManager.emit('session-updated', createSession('session-1', status));

      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
      expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
      expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    },
  );

  it('tracks an active main-repo session solely from events', () => {
    sessionManager.emit(
      'session-created',
      createSession('main-repo-session', 'running', { isMainRepo: true }),
    );

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
  });

  it.each<Session['status']>(['stopped', 'error'])(
    'stops when the last active session reaches %s',
    status => {
      sessionManager.emit('session-created', createSession('session-1', 'running'));
      sessionManager.emit('session-updated', createSession('session-1', status));

      expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
      expect(powerSaveBlocker.stop).toHaveBeenCalledWith(42);
    },
  );

  it('stays held until every active session has stopped', () => {
    sessionManager.emit('session-created', createSession('session-1', 'running'));
    sessionManager.emit('session-created', createSession('session-2', 'waiting'));
    sessionManager.emit('session-updated', createSession('session-1', 'stopped'));

    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();

    sessionManager.emit('session-updated', createSession('session-2', 'stopped'));
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('stays held across a running to waiting to running flap', () => {
    sessionManager.emit('session-created', createSession('session-1', 'running'));
    sessionManager.emit('session-updated', createSession('session-1', 'waiting'));
    sessionManager.emit('session-updated', createSession('session-1', 'running'));

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it('stops when the last active session is archived', () => {
    sessionManager.emit('session-created', createSession('session-1', 'ready'));
    sessionManager.emit('session-deleted', { id: 'session-1' });

    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(42);
  });

  it('acquires and releases for interrupted-session status events', () => {
    sessionManager.emit('session-updated', createSession('resumed-session', 'running'));
    sessionManager.emit('session-updated', createSession('resumed-session', 'stopped'));

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when disabled and remains stopped for later active sessions', () => {
    sessionManager.emit('session-created', createSession('session-1', 'running'));

    configManager.setKeepAwake(false);
    sessionManager.emit('session-updated', createSession('session-1', 'stopped'));
    sessionManager.emit('session-created', createSession('session-2', 'running'));

    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
  });

  it('seeds session statuses from the sessions-loaded event', () => {
    sessionManager.emit('sessions-loaded', [
      createSession('stopped-session', 'stopped'),
      createSession('active-session', 'waiting'),
    ]);

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
  });

  it('keeps a tracked active main-repo session held when sessions-loaded omits it', () => {
    sessionManager.emit(
      'session-created',
      createSession('main-repo-session', 'running', { isMainRepo: true }),
    );

    sessionManager.emit('sessions-loaded', [
      createSession('ordinary-session', 'stopped'),
    ]);

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it('does not reacquire for an archived running update after prior deletion', () => {
    sessionManager.emit('session-deleted', { id: 'archived-session' });
    sessionManager.emit(
      'session-updated',
      createSession('archived-session', 'running', { archived: true }),
    );

    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it('drops a previously active session when a late archived running update arrives', () => {
    sessionManager.emit('session-created', createSession('archived-session', 'running'));
    sessionManager.emit(
      'session-updated',
      createSession('archived-session', 'running', { archived: true }),
    );

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('seeds active sessions from the construction snapshot before any event', () => {
    manager.dispose();
    powerSaveBlocker.start.mockClear();
    powerSaveBlocker.stop.mockClear();

    sessionManager = new SessionManagerStub([
      createSession('main-repo-session', 'running', { isMainRepo: true }),
      createSession('archived-session', 'running', { archived: true }),
      createSession('stopped-session', 'stopped'),
    ]);
    manager = new PowerSaveManager(configManager, sessionManager);
    manager.sync();

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it('defaults keep-awake to enabled for a fresh ConfigManager', () => {
    const freshConfigManager = new ConfigManager();

    expect(freshConfigManager.getConfig().keepAwakeWhileSessionsActive).toBe(true);
  });
});
