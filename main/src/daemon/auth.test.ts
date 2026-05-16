import { describe, expect, it } from 'vitest';
import type { RemoteDaemonClientRecord } from '../../../shared/types/remoteDaemon';
import { authenticateRemoteDaemonBearerToken, hashRemoteDaemonToken } from './auth';

function createClientRecord(id: string, token: string): RemoteDaemonClientRecord {
  return {
    id,
    label: `Client ${id}`,
    createdAt: new Date('2026-05-14T00:00:00.000Z').toISOString(),
    tokenHash: hashRemoteDaemonToken(token),
  };
}

describe('remote daemon auth', () => {
  it('authenticates matching bearer tokens against paired clients', () => {
    const result = authenticateRemoteDaemonBearerToken(
      'Bearer secret-token',
      [createClientRecord('client-1', 'secret-token')],
    );

    expect(result).toEqual({
      ok: true,
      client: createClientRecord('client-1', 'secret-token'),
    });
  });

  it('rejects missing bearer tokens', () => {
    expect(authenticateRemoteDaemonBearerToken(undefined, [createClientRecord('client-1', 'secret-token')])).toEqual({
      ok: false,
      statusCode: 401,
      error: {
        message: 'Remote daemon bearer token is required',
        code: 'ERR_REMOTE_DAEMON_AUTH_REQUIRED',
      },
    });
  });

  it('rejects invalid bearer tokens', () => {
    expect(authenticateRemoteDaemonBearerToken('Bearer wrong-token', [createClientRecord('client-1', 'secret-token')])).toEqual({
      ok: false,
      statusCode: 403,
      error: {
        message: 'Remote daemon bearer token is invalid',
        code: 'ERR_REMOTE_DAEMON_AUTH_INVALID',
      },
    });
  });

  it('rejects malformed authorization schemes', () => {
    expect(authenticateRemoteDaemonBearerToken('Basic abc123', [createClientRecord('client-1', 'secret-token')])).toEqual({
      ok: false,
      statusCode: 401,
      error: {
        message: 'Remote daemon bearer token is required',
        code: 'ERR_REMOTE_DAEMON_AUTH_REQUIRED',
      },
    });
  });
});
