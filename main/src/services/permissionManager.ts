import { PanePermissionBroker } from '../daemon/permissionBroker';
import type {
  PanePermissionInput as PermissionInput,
  PanePermissionRequest as PermissionRequest,
  PanePermissionResponse as PermissionResponse,
} from '../../../shared/types/daemon';

export type { PermissionInput, PermissionRequest, PermissionResponse };

/**
 * Legacy compatibility wrapper around the daemon-owned permission broker.
 *
 * Existing services still import `PermissionManager.getInstance()`. The broker
 * now owns the state and event fanout so remote clients can approve requests
 * without reaching into BrowserWindow globals.
 */
export class PermissionManager {
  static getInstance(): PanePermissionBroker {
    return PanePermissionBroker.getInstance();
  }

  static resetForTests(): void {
    PanePermissionBroker.resetForTests();
  }
}
