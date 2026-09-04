import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';
import type { RemoteMobilePushStatus } from '../../../../shared/types/remoteDaemon';
import type { RemoteRuntimeAdapter } from './remoteRuntimeAdapter';
import { isNativeMobile, nativePushNotifications, nativeSecureStoreCall, type NativeListener } from './nativeMobile';

export interface NativePushRoute { eventId: string; hostProfileId: string; paneId?: string; panelId?: string; }
interface NativePushControlsRequest {
  platform: 'ios' | 'android';
  installationId: string;
  needsInputEnabled?: boolean;
  completedEnabled?: boolean;
}
const INSTALLATION_KEY = 'pane.mobile.installationId';
const PENDING_ROUTE_KEY = 'pane.mobile.pendingPushRoute';
const registrationByProfile = new Map<string, Promise<string | null>>();
let actionListener: NativeListener | null = null;
const routeSchema = boundary.object({ eventId: boundary.nonEmptyString, hostProfileId: boundary.nonEmptyString, paneId: boundary.optional(boundary.nonEmptyString), panelId: boundary.optional(boundary.nonEmptyString) });

/** Install this at app boot, before the user connects to any host. */
export async function installNativePushRouting(): Promise<void> {
  if (!isNativeMobile() || actionListener) return;
  const plugin = nativePushNotifications();
  if (!plugin) throw new Error('This native build does not include the push notification plugin.');
  actionListener = await plugin.addListener('pushNotificationActionPerformed', action => {
    const route = parseActionRoute(action.notification?.data);
    if (!route) return;
    void persistRoute(route).then(() => window.dispatchEvent(new CustomEvent<NativePushRoute>('pane-native-push-route', { detail: route })));
  });
}

export async function consumeNativePushRoute(): Promise<NativePushRoute | null> {
  if (!isNativeMobile()) return null;
  const result = await nativeSecureStoreCall('get', { key: PENDING_ROUTE_KEY });
  const storedRoute = decodeOptionalBoundary(result.value, boundary.string);
  const route = storedRoute ? parseStoredRoute(storedRoute) : null;
  if (route) await nativeSecureStoreCall('remove', { key: PENDING_ROUTE_KEY });
  return route;
}

export async function setupNativePush(profile: RemotePaneConnectionProfile, adapter: RemoteRuntimeAdapter): Promise<string | null> {
  if (!isNativeMobile()) return null;
  const pending = registrationByProfile.get(profile.id);
  if (pending) return pending;
  const attempt = registerProfile(profile, adapter);
  registrationByProfile.set(profile.id, attempt);
  try {
    return await attempt;
  } finally {
    // Keep only concurrent work cached. On a later reconnect ask the platform
    // again so an APNs/FCM token rotation is upserted on the paired host.
    registrationByProfile.delete(profile.id);
  }
}

export async function revokeNativePush(profile: RemotePaneConnectionProfile, adapter: RemoteRuntimeAdapter): Promise<void> {
  if (!isNativeMobile()) return;
  await adapter.invoke<void>('mobile:push-revoke', [{ platform: nativePlatform(), installationId: await getInstallationId(), hostProfileId: profile.id }]);
  registrationByProfile.delete(profile.id);
}

export async function getNativePushStatus(adapter: RemoteRuntimeAdapter): Promise<RemoteMobilePushStatus | null> {
  if (!isNativeMobile()) return null;
  return adapter.invoke<RemoteMobilePushStatus>('mobile:push-status', [{ platform: nativePlatform(), installationId: await getInstallationId() }]);
}

export async function updateNativePushControls(
  adapter: RemoteRuntimeAdapter,
  controls: { needsInputEnabled?: boolean; completedEnabled?: boolean },
): Promise<RemoteMobilePushStatus | null> {
  if (!isNativeMobile()) return null;
  const request: NativePushControlsRequest = {
    platform: nativePlatform(), installationId: await getInstallationId(),
  };
  if (controls.needsInputEnabled !== undefined) request.needsInputEnabled = controls.needsInputEnabled;
  if (controls.completedEnabled !== undefined) request.completedEnabled = controls.completedEnabled;
  return adapter.invoke<RemoteMobilePushStatus>('mobile:push-controls', [request]);
}

async function registerProfile(profile: RemotePaneConnectionProfile, adapter: RemoteRuntimeAdapter): Promise<string | null> {
  const plugin = nativePushNotifications();
  if (!plugin) return 'This native build does not include the push notification plugin.';
  // Do not ask the OS for a durable permission when the paired host cannot
  // deliver a background alert. This is both clearer to the user and avoids a
  // misleading "enabled" system setting for a host with no provider setup.
  try {
    const status = await getNativePushStatus(adapter);
    if (status && status.provider !== 'ready') return status.message;
  } catch (error) {
    return error instanceof Error ? error.message : 'Could not check notification delivery on this host.';
  }
  await installNativePushRouting();
  const permission = await plugin.requestPermissions();
  if (permission.receive !== 'granted') return 'Notifications are off in system settings.';
  const token = await registerForToken(plugin);
  if (!token) return 'The operating system could not register this device for notifications.';
  try {
    const status = await adapter.invoke<{ provider: string; message: string }>('mobile:push-register', [{ platform: nativePlatform(), token, installationId: await getInstallationId(), hostProfileId: profile.id }]);
    return status.provider === 'ready' ? null : status.message;
  } catch (error) { return error instanceof Error ? error.message : 'Notification registration failed.'; }
}

async function registerForToken(plugin: NonNullable<ReturnType<typeof nativePushNotifications>>): Promise<string | null> {
  return new Promise(resolve => {
    const listeners: NativeListener[] = [];
    const finish = (token: string | null) => { for (const listener of listeners) void listener.remove(); resolve(token); };
    void Promise.all([
      plugin.addListener('registration', value => finish(value.value ?? null)).then(listener => { listeners.push(listener); }),
      plugin.addListener('registrationError', () => finish(null)).then(listener => { listeners.push(listener); }),
    ]).then(() => plugin.register()).catch(() => finish(null));
  });
}
function nativePlatform(): 'ios' | 'android' { return /android/i.test(navigator.userAgent) ? 'android' : 'ios'; }
async function getInstallationId(): Promise<string> {
  const result = await nativeSecureStoreCall('get', { key: INSTALLATION_KEY });
  const existing = decodeOptionalBoundary(result.value, boundary.nonEmptyString);
  if (existing) return existing;
  const installationId = crypto.randomUUID();
  await nativeSecureStoreCall('set', { key: INSTALLATION_KEY, value: installationId });
  return installationId;
}
function parseActionRoute(value: JsonObject | undefined): NativePushRoute | null {
  return value === undefined ? null : decodeOptionalBoundary(value, routeSchema) ?? null;
}
function parseStoredRoute(value: string): NativePushRoute | null {
  try { return decodeBoundary(JSON.parse(value), routeSchema); } catch { return null; }
}
async function persistRoute(route: NativePushRoute): Promise<void> { await nativeSecureStoreCall('set', { key: PENDING_ROUTE_KEY, value: JSON.stringify(route) }); }
