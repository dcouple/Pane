import { afterEach, describe, expect, it } from 'vitest';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import type {
  PanePermissionRequest,
  PanePermissionResolvedEvent,
} from '../../../shared/types/daemon';
import { PanePermissionBroker } from './permissionBroker';

function installTestRuntime(events: Array<{ channel: string; args: unknown[] }>): void {
  setPaneRuntime({
    eventSink: {
      send: (channel, ...args) => {
        events.push({ channel, args });
      },
    },
    getConfigManager: () => ({} as never),
    getPtyHostRuntime: () => null,
    getWebviewContextMap: () => new Map(),
  });
}

afterEach(() => {
  PanePermissionBroker.resetForTests();
  resetPaneRuntimeForTests();
});

describe('PanePermissionBroker', () => {
  it('broadcasts permission requests and resolutions through the pane event sink', async () => {
    const events: Array<{ channel: string; args: unknown[] }> = [];
    installTestRuntime(events);

    const broker = PanePermissionBroker.getInstance();
    const permissionPromise = broker.requestPermission('session-1', 'Bash', { command: 'pwd' });

    expect(events).toHaveLength(1);
    expect(events[0]?.channel).toBe('permission:request');

    const request = events[0]?.args[0] as PanePermissionRequest;
    expect(broker.getPendingRequests()).toEqual([request]);

    broker.respondToRequest(request.id, {
      behavior: 'allow',
      updatedInput: { command: 'pwd', cwd: '/tmp' },
      message: 'approved',
    });

    await expect(permissionPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pwd', cwd: '/tmp' },
      message: 'approved',
    });
    expect(broker.getPendingRequests()).toEqual([]);

    expect(events[1]).toEqual({
      channel: 'permission:resolved',
      args: [{
        request,
        response: {
          behavior: 'allow',
          updatedInput: { command: 'pwd', cwd: '/tmp' },
          message: 'approved',
        },
      } satisfies PanePermissionResolvedEvent],
    });
  });

  it('clears session-scoped requests by denying them and emitting resolved events', async () => {
    const events: Array<{ channel: string; args: unknown[] }> = [];
    installTestRuntime(events);

    const broker = PanePermissionBroker.getInstance();
    const sessionOnePromise = broker.requestPermission('session-1', 'Write', { path: 'a.txt' });
    const sessionTwoPromise = broker.requestPermission('session-2', 'Write', { path: 'b.txt' });

    broker.clearPendingRequests('session-1');

    await expect(sessionOnePromise).resolves.toEqual({
      behavior: 'deny',
      message: 'Session terminated',
    });
    expect(broker.getPendingRequests()).toHaveLength(1);
    expect(broker.getPendingRequests()[0]?.sessionId).toBe('session-2');

    const resolvedEvent = events.find((event) => event.channel === 'permission:resolved');
    expect(resolvedEvent?.args[0]).toEqual({
      request: expect.objectContaining({ sessionId: 'session-1' }),
      response: {
        behavior: 'deny',
        message: 'Session terminated',
      },
    });

    broker.respondToRequest(broker.getPendingRequests()[0]!.id, {
      behavior: 'allow',
    });
    await expect(sessionTwoPromise).resolves.toEqual({ behavior: 'allow' });
  });
});
