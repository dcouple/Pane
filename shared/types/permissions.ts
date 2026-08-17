import type { JsonObject } from '../validation/boundaryDecoder';

export type PanePermissionInput = JsonObject;

export interface PanePermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: PanePermissionInput;
  timestamp: number;
}

export interface PanePermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: PanePermissionInput;
  message?: string;
}

export interface PanePermissionResolvedEvent {
  request: PanePermissionRequest;
  response: PanePermissionResponse;
}
