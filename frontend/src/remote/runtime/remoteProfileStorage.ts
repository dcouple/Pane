import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';
import { isRemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { isNativeMobile, nativeSecureStoreCall } from './nativeMobile';

const SAVED_PROFILES_KEY = 'pane.remotePwa.savedProfiles';
export async function loadRemoteProfiles(): Promise<RemotePaneConnectionProfile[]> {
  if (!isNativeMobile()) return loadBrowserProfiles();
  const result = await nativeSecureStoreCall('get', { key: SAVED_PROFILES_KEY });
  return parseProfiles(decodeOptionalBoundary(result.value, boundary.string) ?? null);
}
export async function saveRemoteProfiles(profiles: RemotePaneConnectionProfile[]): Promise<void> {
  const value = JSON.stringify(profiles);
  if (isNativeMobile()) { await nativeSecureStoreCall('set', { key: SAVED_PROFILES_KEY, value }); return; }
  window.localStorage.setItem(SAVED_PROFILES_KEY, value);
}
function loadBrowserProfiles(): RemotePaneConnectionProfile[] { try { return parseProfiles(window.localStorage.getItem(SAVED_PROFILES_KEY)); } catch { return []; } }
function parseProfiles(value: string | null): RemotePaneConnectionProfile[] {
  try {
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter(isRemotePaneConnectionProfile) : [];
  } catch { return []; }
}
