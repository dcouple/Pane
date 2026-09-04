import { describe, expect, it } from 'vitest';
import config from '../capacitor.config';

describe('native Capacitor configuration', () => {
  it('bundles local web assets without a remote server bridge', () => {
    expect(config.webDir).toBe('www');
    expect(config.server?.url).toBeUndefined();
  });

  it('uses an HTTPS Android origin and native alert presentation', () => {
    expect(config.server?.androidScheme).toBe('https');
    expect(config.plugins?.PushNotifications?.presentationOptions).toContain('alert');
  });
});
