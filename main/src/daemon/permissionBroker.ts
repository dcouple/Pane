import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { getPaneEventSink } from '../core/runtime';
import type {
  PanePermissionInput,
  PanePermissionRequest,
  PanePermissionResolvedEvent,
  PanePermissionResponse,
} from '../../../shared/types/daemon';

export class PanePermissionBroker extends EventEmitter {
  private readonly pendingRequests = new Map<string, PanePermissionRequest>();
  private static instance: PanePermissionBroker | null = null;

  static getInstance(): PanePermissionBroker {
    if (!PanePermissionBroker.instance) {
      PanePermissionBroker.instance = new PanePermissionBroker();
    }

    return PanePermissionBroker.instance;
  }

  static resetForTests(): void {
    PanePermissionBroker.instance?.removeAllListeners();
    PanePermissionBroker.instance = null;
  }

  getPendingRequests(): PanePermissionRequest[] {
    return [...this.pendingRequests.values()];
  }

  async requestPermission(
    sessionId: string,
    toolName: string,
    input: PanePermissionInput,
  ): Promise<PanePermissionResponse> {
    const request: PanePermissionRequest = {
      id: randomUUID(),
      sessionId,
      toolName,
      input,
      timestamp: Date.now(),
    };

    this.pendingRequests.set(request.id, request);
    getPaneEventSink().send('permission:request', request);

    return new Promise((resolve) => {
      this.once(`response:${request.id}`, (response: PanePermissionResponse) => {
        resolve(response);
      });
    });
  }

  respondToRequest(requestId: string, response: PanePermissionResponse): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      throw new Error(`No pending permission request with id ${requestId}`);
    }

    this.resolveRequest(request, response);
  }

  clearPendingRequests(sessionId?: string): void {
    const requests = [...this.pendingRequests.values()].filter((request) => (
      sessionId ? request.sessionId === sessionId : true
    ));

    for (const request of requests) {
      this.resolveRequest(request, {
        behavior: 'deny',
        message: sessionId ? 'Session terminated' : 'All requests cleared',
      });
    }
  }

  private resolveRequest(request: PanePermissionRequest, response: PanePermissionResponse): void {
    this.pendingRequests.delete(request.id);
    this.emit(`response:${request.id}`, response);

    const payload: PanePermissionResolvedEvent = {
      request,
      response,
    };
    getPaneEventSink().send('permission:resolved', payload);
  }
}
