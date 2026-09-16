import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';

export interface NativeListener { remove(): Promise<void>; }
interface NativePushNotificationAction { notification?: { data?: JsonObject }; }
export interface NativePushNotificationsPlugin {
  requestPermissions(): Promise<{ receive?: string }>;
  register(): Promise<void>;
  addListener(event: 'registration', listener: (value: { value?: string }) => void): Promise<NativeListener>;
  addListener(event: 'registrationError', listener: () => void): Promise<NativeListener>;
  addListener(event: 'pushNotificationActionPerformed', listener: (value: NativePushNotificationAction) => void): Promise<NativeListener>;
}
interface SecureStorePlugin {
  get(args: JsonObject): Promise<JsonObject>;
  set(args: JsonObject): Promise<JsonObject>;
  remove(args: JsonObject): Promise<JsonObject>;
}
interface NativeAppPlugin {
  addListener(event: 'appStateChange', listener: (value: JsonObject) => void): Promise<NativeListener>;
  addListener(event: 'backButton', listener: (value: JsonObject) => void): Promise<NativeListener>;
}
interface NativeBrowserPlugin { open(args: { url: string }): Promise<JsonObject>; }
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { SecureStore?: SecureStorePlugin; PushNotifications?: NativePushNotificationsPlugin; App?: NativeAppPlugin; Browser?: NativeBrowserPlugin; };
}
declare global { interface Window { Capacitor?: CapacitorGlobal; } }

/** Browser bundles never import Capacitor; this only reads its runtime global. */
function capacitor(): CapacitorGlobal | null { return window.Capacitor ?? null; }
export function isNativeMobile(): boolean { return capacitor()?.isNativePlatform?.() === true; }
export function nativePushNotifications(): NativePushNotificationsPlugin | null {
  return isNativeMobile() ? capacitor()?.Plugins?.PushNotifications ?? null : null;
}
export async function nativeSecureStoreCall(method: 'get' | 'set' | 'remove', args: JsonObject): Promise<JsonObject> {
  if (!isNativeMobile()) throw new Error('Secure storage is only available in the native app.');
  const plugin = capacitor()?.Plugins?.SecureStore;
  if (!plugin) throw new Error('This native build does not include secure storage.');
  return plugin[method](args);
}
export async function addNativeAppListener(event: 'appStateChange' | 'backButton', listener: (value: JsonObject) => void): Promise<NativeListener | null> {
  if (!isNativeMobile()) return null;
  const plugin = capacitor()?.Plugins?.App;
  if (!plugin) throw new Error('This native build does not include app lifecycle support.');
  if (event === 'appStateChange') return plugin.addListener('appStateChange', listener);
  return plugin.addListener('backButton', listener);
}
export async function openNativeExternalUrl(url: string): Promise<void> {
  if (!isNativeMobile()) return;
  const browser = capacitor()?.Plugins?.Browser;
  if (!browser) throw new Error('This native build does not include external-link support.');
  await browser.open({ url });
}
