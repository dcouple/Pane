import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type {
  AgentUsageLimit,
  AgentUsageProviderSnapshot,
  AgentUsageSnapshot,
} from '../../../shared/types/agentUsage';
import { getShellPath } from '../utils/shellPath';
import { getWSLExecArgs, type WSLContext } from '../utils/wslUtils';

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 12_000;
const MAX_PROTOCOL_BUFFER_BYTES = 1_000_000;
const PROCESS_SHUTDOWN_GRACE_MS = 500;

interface AgentUsageTarget {
  cacheKey: string;
  cwd: string;
  wslContext: WSLContext | null;
}

interface CachedSnapshot {
  expiresAt: number;
  snapshot: AgentUsageSnapshot;
}

interface JsonRpcMessage {
  id?: number | string;
  result?: unknown;
  error?: unknown;
}

interface CodexProbeResult {
  account: unknown;
  rateLimits: unknown;
}

type CodexProbe = (target: AgentUsageTarget) => Promise<CodexProbeResult>;
type CodexProcessFactory = (target: AgentUsageTarget) => ChildProcessWithoutNullStreams;
type CodexProcessTerminator = (child: ChildProcessWithoutNullStreams) => Promise<void>;
type WindowsProcessTreeKiller = (pid: number) => Promise<void>;

interface CodexSpawnCommand {
  file: string;
  args: string[];
  cwd: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function titleCaseIdentifier(value: string): string {
  return value
    .replace(/prolite/gi, 'pro_lite')
    .split(/[_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatWindowName(durationMinutes: number | null): string {
  if (durationMinutes === 10_080) return 'Weekly limit';
  if (durationMinutes === 1_440) return 'Daily limit';
  if (durationMinutes === 300) return '5-hour limit';
  if (durationMinutes !== null && durationMinutes > 0) {
    if (durationMinutes % 1_440 === 0) return `${durationMinutes / 1_440}-day limit`;
    if (durationMinutes % 60 === 0) return `${durationMinutes / 60}-hour limit`;
    return `${durationMinutes}-minute limit`;
  }
  return 'Usage limit';
}

function normalizeWindow(
  limitId: string,
  limitName: string | null,
  windowKind: 'primary' | 'secondary',
  value: unknown,
): AgentUsageLimit | null {
  if (!isRecord(value)) return null;
  const usedPercent = optionalNumber(value.usedPercent);
  if (usedPercent === null) return null;

  const windowDurationMinutes = optionalNumber(value.windowDurationMins);
  const resetSeconds = optionalNumber(value.resetsAt);
  const windowName = formatWindowName(windowDurationMinutes);
  const name = limitName
    ? windowDurationMinutes === null ? limitName : `${limitName} ${windowName.toLowerCase()}`
    : windowName;

  return {
    id: `${limitId}:${windowKind}`,
    name,
    remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - usedPercent))),
    windowDurationMinutes,
    resetsAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
  };
}

function normalizeLimitSnapshot(value: unknown, fallbackId: string): AgentUsageLimit[] {
  if (!isRecord(value)) return [];
  const limitId = optionalString(value.limitId) ?? fallbackId;
  const limitName = optionalString(value.limitName);
  const primary = normalizeWindow(limitId, limitName, 'primary', value.primary);
  const secondary = normalizeWindow(limitId, limitName, 'secondary', value.secondary);
  return [primary, secondary].filter((limit): limit is AgentUsageLimit => limit !== null);
}

export function normalizeCodexUsage(
  accountPayload: unknown,
  rateLimitsPayload: unknown,
  fetchedAt = new Date(),
): AgentUsageProviderSnapshot {
  if (!isRecord(accountPayload) || !isRecord(rateLimitsPayload)) {
    throw new Error('Codex returned an invalid account usage response');
  }

  const account = isRecord(accountPayload.account) ? accountPayload.account : null;
  const rawPlan = optionalString(account?.planType);

  const buckets = isRecord(rateLimitsPayload.rateLimitsByLimitId)
    ? Object.entries(rateLimitsPayload.rateLimitsByLimitId)
    : [];
  const rawLimits = buckets.length > 0
    ? buckets
    : [['codex', rateLimitsPayload.rateLimits] as const];
  const limits = rawLimits.flatMap(([limitId, value]) => normalizeLimitSnapshot(value, limitId));
  limits.sort((left, right) => {
    const leftDefault = left.id.startsWith('codex:') ? 0 : 1;
    const rightDefault = right.id.startsWith('codex:') ? 0 : 1;
    const leftWeekly = left.windowDurationMinutes === 10_080 ? 0 : 1;
    const rightWeekly = right.windowDurationMinutes === 10_080 ? 0 : 1;
    return leftDefault - rightDefault || leftWeekly - rightWeekly || left.name.localeCompare(right.name);
  });

  return {
    id: 'codex',
    name: 'Codex',
    status: 'available',
    plan: rawPlan ? titleCaseIdentifier(rawPlan) : null,
    limits,
    fetchedAt: fetchedAt.toISOString(),
  };
}

export function getCodexSpawnCommand(target: AgentUsageTarget): CodexSpawnCommand {
  if (target.wslContext) {
    const command = getWSLExecArgs(
      'codex app-server --listen stdio://',
      target.wslContext.distribution,
      target.wslContext.linuxPath,
    );
    return { ...command, cwd: undefined };
  }

  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'codex app-server --listen stdio://'],
      cwd: target.cwd,
    };
  }

  return {
    file: 'codex',
    args: ['app-server', '--listen', 'stdio://'],
    cwd: target.cwd,
  };
}

function createCodexProcess(target: AgentUsageTarget): ChildProcessWithoutNullStreams {
  const env = { ...process.env, PATH: getShellPath() };
  const command = getCodexSpawnCommand(target);
  const spawnOptions = {
    cwd: command.cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  };
  return spawn(command.file, command.args, spawnOptions);
}

function waitForProcessClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise(resolve => {
    const onClose = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (closed: boolean) => {
      clearTimeout(timeout);
      child.off('close', onClose);
      resolve(closed);
    };
    child.once('close', onClose);
  });
}

function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    execFile(
      'taskkill',
      ['/F', '/T', '/PID', String(pid)],
      { windowsHide: true, timeout: 2_000 },
      () => resolve(),
    );
  });
}

export async function terminateCodexProcess(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform = process.platform,
  graceMs = PROCESS_SHUTDOWN_GRACE_MS,
  killWindowsTree: WindowsProcessTreeKiller = killWindowsProcessTree,
): Promise<void> {
  if (!child.stdin.destroyed && !child.stdin.writableEnded) {
    try {
      child.stdin.end();
    } catch {
      // The probe's stream error handler owns shutdown errors.
    }
  }

  if (await waitForProcessClose(child, graceMs)) return;

  if (platform === 'win32' && child.pid) {
    await killWindowsTree(child.pid);
  }

  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      // The process may have exited between the state check and kill.
    }
  }
}

function writeProtocolMessage(
  child: ChildProcessWithoutNullStreams,
  message: object,
  onError: (error: Error) => void,
): void {
  if (child.stdin.destroyed || child.stdin.writableEnded) {
    onError(new Error('Codex closed the usage protocol input'));
    return;
  }

  try {
    child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error) onError(new Error(`Unable to write to Codex usage protocol: ${error.message}`));
    });
  } catch (error) {
    onError(error instanceof Error ? error : new Error('Unable to write to Codex usage protocol'));
  }
}

export async function probeCodexUsage(
  target: AgentUsageTarget,
  createProcess: CodexProcessFactory = createCodexProcess,
  terminateProcess: CodexProcessTerminator = terminateCodexProcess,
): Promise<CodexProbeResult> {
  return new Promise((resolve, reject) => {
    const child = createProcess(target);
    let stdoutBuffer = '';
    let stderr = '';
    let account: unknown;
    let rateLimits: unknown;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void terminateProcess(child).then(() => {
        if (error) reject(error);
        else resolve({ account, rateLimits });
      }, () => {
        if (error) reject(error);
        else resolve({ account, rateLimits });
      });
    };

    const sendProtocolMessage = (message: object) => {
      if (settled) return;
      writeProtocolMessage(child, message, error => finish(error));
    };

    const timeout = setTimeout(() => {
      finish(new Error('Timed out while reading Codex usage'));
    }, PROBE_TIMEOUT_MS);

    child.on('error', error => finish(new Error(`Unable to start Codex: ${error.message}`)));
    child.stdin.on('error', error => {
      finish(new Error(`Unable to write to Codex usage protocol: ${error.message}`));
    });
    child.on('exit', code => {
      if (!settled) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
        finish(new Error(`Codex usage process exited with code ${code ?? 'unknown'}${detail}`));
      }
    });
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    child.stdout.on('data', chunk => {
      stdoutBuffer += String(chunk);
      if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_PROTOCOL_BUFFER_BYTES) {
        finish(new Error('Codex usage response exceeded the protocol limit'));
        return;
      }

      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');
        if (!line) continue;

        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(new Error('Codex app server initialization failed'));
            return;
          }
          // Codex app-server uses a JSON-RPC handshake before the paired account and
          // rate-limit reads; non-JSON stdout is ignored until both replies arrive.
          sendProtocolMessage({ method: 'initialized' });
          sendProtocolMessage({
            method: 'account/read',
            id: 2,
            params: { refreshToken: false },
          });
          sendProtocolMessage({ method: 'account/rateLimits/read', id: 3 });
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error('Codex account information is unavailable'));
            return;
          }
          account = message.result;
        } else if (message.id === 3) {
          if (message.error) {
            finish(new Error('Codex usage limits are unavailable'));
            return;
          }
          rateLimits = message.result;
        }

        if (account !== undefined && rateLimits !== undefined) {
          finish();
          return;
        }
      }
    });

    sendProtocolMessage({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'pane', title: 'Pane', version: '1.0.0' },
        capabilities: null,
      },
    });
  });
}

export class AgentUsageService {
  private readonly cache = new Map<string, CachedSnapshot>();
  private readonly pending = new Map<string, Promise<AgentUsageSnapshot>>();

  constructor(
    private readonly probe: CodexProbe = probeCodexUsage,
    private readonly cacheTtlMs = CACHE_TTL_MS,
  ) {}

  async getSnapshot(target: AgentUsageTarget, force = false): Promise<AgentUsageSnapshot> {
    const cached = this.cache.get(target.cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.snapshot;

    const existing = this.pending.get(target.cacheKey);
    if (existing) return existing;

    const request = this.loadSnapshot(target).finally(() => {
      this.pending.delete(target.cacheKey);
    });
    this.pending.set(target.cacheKey, request);
    return request;
  }

  private async loadSnapshot(target: AgentUsageTarget): Promise<AgentUsageSnapshot> {
    const fetchedAt = new Date();
    let provider: AgentUsageProviderSnapshot;
    try {
      const result = await this.probe(target);
      provider = normalizeCodexUsage(result.account, result.rateLimits, fetchedAt);
    } catch (error) {
      console.warn('[AgentUsageService] Codex usage unavailable:', error);
      provider = {
        id: 'codex',
        name: 'Codex',
        status: 'unavailable',
        plan: null,
        limits: [],
        fetchedAt: fetchedAt.toISOString(),
        error: error instanceof Error ? error.message : 'Codex usage is unavailable',
      };
    }

    const snapshot = { providers: [provider], fetchedAt: fetchedAt.toISOString() };
    this.cache.set(target.cacheKey, {
      expiresAt: Date.now() + this.cacheTtlMs,
      snapshot,
    });
    return snapshot;
  }
}

export const agentUsageService = new AgentUsageService();
export type { AgentUsageTarget };
