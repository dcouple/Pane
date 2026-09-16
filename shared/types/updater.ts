export type UpdateMode = 'seamless' | 'manual';

export type UpdateModeReason =
  | 'platform-supported'
  | 'development-build'
  | 'trusted-dcouple-signature'
  | 'untrusted-signature';

export interface UpdateCapabilities {
  mode: UpdateMode;
  reason: UpdateModeReason;
}
