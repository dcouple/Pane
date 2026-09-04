import { generateKeyPairSync } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { MobilePushSender, type MobilePushTransport } from './mobilePushSender';

const originalEnvironment = {
  team: process.env.PANE_APNS_TEAM_ID,
  key: process.env.PANE_APNS_KEY_ID,
  keyPath: process.env.PANE_APNS_KEY_PATH,
  topic: process.env.PANE_APNS_TOPIC,
  environment: process.env.PANE_APNS_ENVIRONMENT,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  setEnvironment(originalEnvironment);
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('MobilePushSender', () => {
  it('delivers blocked and completed transitions once with a host-profile tap route', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-push-'));
    temporaryDirectories.push(directory);
    const keyPath = path.join(directory, 'AuthKey.p8');
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await writeFile(keyPath, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    setEnvironment({ team: 'TEAM', key: 'KEY', keyPath, topic: 'com.dcouple.pane.mobile', environment: 'sandbox' });

    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
    const manager = new ConfigManagerStub(config);
    const requests: Parameters<MobilePushTransport['apns']>[0][] = [];
    const transport: MobilePushTransport = {
      apns: async request => { requests.push(request); return { status: 200, body: '' }; },
      fcm: async () => ({ status: 200, body: '' }),
    };
    const sender = new MobilePushSender(manager, transport);

    await sender.register('client-1', { platform: 'ios', token: 'token', installationId: 'install-1', hostProfileId: 'profile-1' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'working', reason: 'working' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'idle', reason: 'done' });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.payload).toMatchObject({ hostProfileId: 'profile-1', paneId: 'pane-1', panelId: 'panel-1' });
    expect(Buffer.from(requests[0]?.jwt.split('.')[2] ?? '', 'base64url')).toHaveLength(64);
    expect(manager.config.host.mobilePush.registrations[0]?.recentEventIds).toHaveLength(2);
  });
});

class ConfigManagerStub {
  config: RemoteDaemonConfig;
  constructor(config: RemoteDaemonConfig) { this.config = config; }
  getConfig() { return { remoteDaemon: this.config }; }
  async updateConfig(update: { remoteDaemon: RemoteDaemonConfig }): Promise<{ remoteDaemon: RemoteDaemonConfig }> {
    this.config = update.remoteDaemon;
    return { remoteDaemon: this.config };
  }
}

function setEnvironment(values: { team?: string; key?: string; keyPath?: string; topic?: string; environment?: string }): void {
  setEnvironmentValue('PANE_APNS_TEAM_ID', values.team);
  setEnvironmentValue('PANE_APNS_KEY_ID', values.key);
  setEnvironmentValue('PANE_APNS_KEY_PATH', values.keyPath);
  setEnvironmentValue('PANE_APNS_TOPIC', values.topic);
  setEnvironmentValue('PANE_APNS_ENVIRONMENT', values.environment);
}
function setEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
