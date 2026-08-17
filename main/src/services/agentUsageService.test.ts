import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentUsageService,
  getCodexSpawnCommand,
  normalizeCodexUsage,
  probeCodexUsage,
  terminateCodexProcess,
  type AgentUsageTarget,
} from './agentUsageService';

const target: AgentUsageTarget = {
  cacheKey: 'windows:host',
  cwd: 'C:\\repo',
  wslContext: null,
};

const accountResponse = {
  account: { type: 'chatgpt', email: 'dev@example.com', planType: 'prolite' },
  requiresOpenaiAuth: true,
};

const rateLimitsResponse = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 43, windowDurationMins: 10_080, resetsAt: 1_787_213_128 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 43, windowDurationMins: 10_080, resetsAt: 1_787_213_128 },
      secondary: null,
    },
    codex_spark: {
      limitId: 'codex_spark',
      limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_787_342_334 },
      secondary: null,
    },
  },
};

function createFakeChild(stdin: Writable): ChildProcessWithoutNullStreams {
  // SAFETY: The service test exercises only these modeled child-process streams, state fields, and kill method.
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}

describe('normalizeCodexUsage', () => {
  it('normalizes account details and every named rate-limit bucket', () => {
    const fetchedAt = new Date('2026-08-14T12:00:00.000Z');
    const snapshot = normalizeCodexUsage(accountResponse, rateLimitsResponse, fetchedAt);

    expect(snapshot).toMatchObject({
      id: 'codex',
      name: 'Codex',
      status: 'available',
      plan: 'Pro Lite',
      fetchedAt: fetchedAt.toISOString(),
    });
    expect(snapshot).not.toHaveProperty('accountLabel');
    expect(snapshot.limits).toEqual([
      {
        id: 'codex:primary',
        name: 'Weekly limit',
        remainingPercent: 57,
        windowDurationMinutes: 10_080,
        resetsAt: new Date(1_787_213_128_000).toISOString(),
      },
      {
        id: 'codex_spark:primary',
        name: 'GPT-5.3-Codex-Spark weekly limit',
        remainingPercent: 100,
        windowDurationMinutes: 10_080,
        resetsAt: new Date(1_787_342_334_000).toISOString(),
      },
    ]);
  });

  it('uses the backward-compatible single bucket and clamps percentages', () => {
    const snapshot = normalizeCodexUsage(
      { account: { type: 'apiKey' } },
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 125, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
        rateLimitsByLimitId: null,
      },
    );

    expect(snapshot.plan).toBeNull();
    expect(snapshot.limits[0]).toMatchObject({
      name: '5-hour limit',
      remainingPercent: 0,
      resetsAt: null,
    });
  });
});

describe('AgentUsageService', () => {
  it('caches reads by environment and supports a forced refresh', async () => {
    const probe = vi.fn(async () => ({ account: accountResponse, rateLimits: rateLimitsResponse }));
    const service = new AgentUsageService(probe, 10_000);

    const first = await service.getSnapshot(target);
    const second = await service.getSnapshot(target);
    const refreshed = await service.getSnapshot(target, true);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
    expect(refreshed.providers[0].status).toBe('available');
  });

  it('returns an unavailable provider without rejecting the whole widget', async () => {
    const service = new AgentUsageService(async () => {
      throw new Error('codex not found');
    });

    const snapshot = await service.getSnapshot(target);

    expect(snapshot.providers).toEqual([
      expect.objectContaining({
        id: 'codex',
        status: 'unavailable',
        error: 'codex not found',
      }),
    ]);
  });
});

describe('probeCodexUsage', () => {
  it('runs WSL Codex from the pane Linux working directory', () => {
    const command = getCodexSpawnCommand({
      cacheKey: "wsl:Ubuntu:/home/dev/o'connor/pane",
      cwd: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\o'connor\\pane",
      wslContext: {
        enabled: true,
        distribution: 'Ubuntu',
        linuxPath: "/home/dev/o'connor/pane",
      },
    });

    expect(command).toEqual({
      file: 'wsl.exe',
      args: [
        '-d',
        'Ubuntu',
        '--',
        'bash',
        '-c',
        "cd '/home/dev/o'\\''connor/pane' && codex app-server --listen stdio://",
      ],
      cwd: undefined,
    });
  });

  it('rejects safely when Codex closes stdin during the protocol handshake', async () => {
    let writeCount = 0;
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        writeCount += 1;
        if (writeCount === 1) callback();
        else callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const child = createFakeChild(stdin);
    const terminate = vi.fn(async () => undefined);
    const result = probeCodexUsage(target, () => child, terminate);

    child.stdout.write('{"id":1,"result":{}}\n');

    await expect(result).rejects.toThrow(/EPIPE|usage protocol/);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('terminates the full Windows wrapper process tree after the grace period', async () => {
    const child = createFakeChild(new PassThrough());
    const killWindowsTree = vi.fn(async () => undefined);

    await terminateCodexProcess(child, 'win32', 0, killWindowsTree);

    expect(killWindowsTree).toHaveBeenCalledWith(42);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
