import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import type { App, ProcessMetric } from 'electron';
import type {
  ElectronProcessInfo,
  ChildProcessInfo,
  SessionResourceInfo,
  ResourceSnapshot,
} from '../../../shared/types/resourceMonitor';

const execFileAsync = promisify(execFile);

interface RawProcessStats {
  name: string;
  cpuTimeSeconds: number; // Cumulative CPU time in seconds
  memoryMB: number;
}

interface CpuSample {
  cpuTimeSeconds: number;
  timestamp: number;
}

interface WindowsBatchItem {
  Id: number;
  Name: string;
  CpuSeconds: number;
  MemoryMB: number;
}

export class ResourceMonitorService extends EventEmitter {
  private app: App | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private isActivePolling = false;
  private pollInProgress = false;
  private previousCpuSamples = new Map<number, CpuSample>();
  private isHidden = false;
  private needsCpuWarmup = false;

  initialize(app: App): void {
    this.app = app;
  }

  private getElectronMetrics(): ElectronProcessInfo[] {
    if (!this.app) return [];
    const metrics: ProcessMetric[] = this.app.getAppMetrics();
    if (!metrics || metrics.length === 0) return [];
    return metrics.map(m => ({
      pid: m.pid,
      type: m.type,
      label: m.type === 'Browser' ? 'Main' : m.type === 'Tab' ? 'Renderer' : m.type,
      cpuPercent: m.cpu.percentCPUUsage,
      memoryMB: Math.round((m.memory.workingSetSize / 1024) * 100) / 100, // KB → MB
    }));
  }

  private async getChildPids(parentPid: number): Promise<number[]> {
    try {
      if (os.platform() === 'win32') {
        const { stdout } = await execFileAsync(
          'powershell',
          ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object -ExpandProperty ProcessId`],
          { encoding: 'utf8', timeout: 5000 }
        );
        return stdout.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n));
      } else if (os.platform() === 'darwin') {
        const { stdout } = await execFileAsync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8', timeout: 5000 });
        return stdout.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n));
      } else {
        const { stdout } = await execFileAsync('ps', ['-o', 'pid=', '--ppid', String(parentPid)], { encoding: 'utf8', timeout: 5000 });
        return stdout.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n));
      }
    } catch {
      return [];
    }
  }

  private async getAllDescendantPids(parentPid: number): Promise<number[]> {
    const children = await this.getChildPids(parentPid);
    const all: number[] = [...children];
    for (const child of children) {
      all.push(...await this.getAllDescendantPids(child));
    }
    return all;
  }

  /**
   * Parse a cputime string from `ps -o cputime=` into total seconds.
   * Formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS"
   */
  private parseCputime(cputime: string): number {
    const trimmed = cputime.trim();
    if (!trimmed) return 0;

    let days = 0;
    let rest = trimmed;

    // Check for "D-" day prefix
    const dayMatch = rest.match(/^(\d+)-(.+)$/);
    if (dayMatch) {
      days = parseInt(dayMatch[1], 10);
      rest = dayMatch[2];
    }

    const parts = rest.split(':').map(p => parseInt(p, 10));
    let hours = 0, minutes = 0, seconds = 0;

    if (parts.length === 3) {
      [hours, minutes, seconds] = parts;
    } else if (parts.length === 2) {
      [minutes, seconds] = parts;
    } else {
      return 0;
    }

    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * Compute delta-based CPU percentage for a PID using cached previous samples.
   * Returns 0 on first observation (no previous sample to compare against).
   */
  private computeDeltaCpu(pid: number, currentCpuTimeSeconds: number, currentTimestamp: number): number {
    const prev = this.previousCpuSamples.get(pid);
    this.previousCpuSamples.set(pid, { cpuTimeSeconds: currentCpuTimeSeconds, timestamp: currentTimestamp });

    if (!prev) return 0;

    const deltaWallSeconds = (currentTimestamp - prev.timestamp) / 1000;
    if (deltaWallSeconds <= 0) return 0;

    const deltaCpu = currentCpuTimeSeconds - prev.cpuTimeSeconds;
    if (deltaCpu < 0) return 0; // Process restarted with same PID

    return Math.round((deltaCpu / deltaWallSeconds) * 100 * 10) / 10;
  }

  /**
   * Remove stale entries from the CPU sample cache for PIDs no longer being tracked.
   */
  private cleanupCpuSampleCache(activePids: Set<number>): void {
    for (const pid of this.previousCpuSamples.keys()) {
      if (!activePids.has(pid)) {
        this.previousCpuSamples.delete(pid);
      }
    }
  }

  private async getUnixProcessStats(pid: number): Promise<RawProcessStats> {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'comm=,cputime=,rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      const line = stdout.trim();
      if (!line) return { name: 'unknown', cpuTimeSeconds: 0, memoryMB: 0 };
      const parts = line.split(/\s+/);
      const rss = parseInt(parts[parts.length - 1], 10) || 0;
      const cputime = parts[parts.length - 2] || '0:00';
      const name = parts.slice(0, -2).join(' ') || 'unknown';
      return { name, cpuTimeSeconds: this.parseCputime(cputime), memoryMB: rss / 1024 };
    } catch {
      return { name: 'unknown', cpuTimeSeconds: 0, memoryMB: 0 };
    }
  }

  private async getUnixBatchRawStats(pids: number[]): Promise<Map<number, RawProcessStats>> {
    const result = new Map<number, RawProcessStats>();
    if (pids.length === 0) return result;
    // Batch all PIDs into a single ps call
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'pid=,comm=,cputime=,rss=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5000 });
      for (const line of stdout.trim().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pid = parseInt(parts[0], 10);
        if (isNaN(pid)) continue;
        const rss = parseInt(parts[parts.length - 1], 10) || 0;
        const cputime = parts[parts.length - 2] || '0:00';
        const name = parts.slice(1, -2).join(' ') || 'unknown';
        result.set(pid, { name, cpuTimeSeconds: this.parseCputime(cputime), memoryMB: rss / 1024 });
      }
    } catch {
      // Fallback: try individual lookups for any PIDs not found
      const promises = pids.map(async pid => {
        const stats = await this.getUnixProcessStats(pid);
        result.set(pid, stats);
      });
      await Promise.all(promises);
    }
    return result;
  }

  private async getWindowsBatchRawStats(pids: number[]): Promise<Map<number, RawProcessStats>> {
    const result = new Map<number, RawProcessStats>();
    if (pids.length === 0) return result;
    try {
      const pidList = pids.join(',');
      const psCmd = `Get-Process -Id @(${pidList}) -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Id=$_.Id; Name=$_.ProcessName; CpuSeconds=[math]::Round($_.CPU,2); MemoryMB=[math]::Round($_.WorkingSet64/1MB,1) } } | ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', psCmd],
        { encoding: 'utf8', timeout: 10000 }
      );
      const parsed: unknown = JSON.parse(stdout);
      const items: WindowsBatchItem[] = Array.isArray(parsed) ? parsed as WindowsBatchItem[] : [parsed as WindowsBatchItem];
      for (const item of items) {
        if (item && typeof item.Id === 'number') {
          result.set(item.Id, {
            name: item.Name || 'unknown',
            cpuTimeSeconds: item.CpuSeconds || 0,
            memoryMB: item.MemoryMB || 0,
          });
        }
      }
    } catch {
      // PowerShell call failed — return empty results
    }
    return result;
  }

  /**
   * Convert raw process stats (cumulative CPU time) into final stats (delta-based CPU %).
   */
  private resolveProcessStats(pids: number[], rawStats: Map<number, RawProcessStats>, now: number): ChildProcessInfo[] {
    return pids
      .map(pid => {
        const raw = rawStats.get(pid) || { name: 'unknown', cpuTimeSeconds: 0, memoryMB: 0 };
        const cpuPercent = this.computeDeltaCpu(pid, raw.cpuTimeSeconds, now);
        return { pid, name: raw.name, cpuPercent, memoryMB: raw.memoryMB };
      })
      .filter(c => c.cpuPercent > 0 || c.memoryMB > 0.1);
  }

  private async getSessionMetrics(): Promise<SessionResourceInfo[]> {
    const now = Date.now();

    // Lazy imports to avoid circular dependency at module load time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { terminalPanelManager } = require('./terminalPanelManager') as { terminalPanelManager: { getSessionPids(): Map<string, number[]> } };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sessionManager } = require('../index') as { sessionManager: { getSession(id: string): { name?: string; initial_prompt?: string } | undefined } | null };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CliToolRegistry } = require('./cliToolRegistry') as { CliToolRegistry: { getInstance(): { getAllManagers(): { getSessionPids(): Map<string, number[]> }[] } } };

    // Collect PIDs from all sources: terminal panels + CLI managers (Claude, Codex, etc.)
    const sessionPids = new Map<string, number[]>();

    // Terminal panel PIDs (bash shells)
    for (const [sessionId, pids] of terminalPanelManager.getSessionPids()) {
      sessionPids.set(sessionId, [...pids]);
    }

    // CLI manager PIDs (Claude Code, Codex, and any future CLI tools)
    try {
      const registry = CliToolRegistry.getInstance();
      for (const manager of registry.getAllManagers()) {
        for (const [sessionId, pids] of manager.getSessionPids()) {
          const existing = sessionPids.get(sessionId) || [];
          existing.push(...pids);
          sessionPids.set(sessionId, existing);
        }
      }
    } catch {
      // Registry may not be initialized yet during startup
    }

    const sessions: SessionResourceInfo[] = [];
    const allTrackedPids = new Set<number>();

    for (const [sessionId, ptyPids] of sessionPids) {
      const session = sessionManager?.getSession?.(sessionId);
      const sessionName = session?.name || session?.initial_prompt?.slice(0, 30) || sessionId;

      const allPids: number[] = [];
      for (const ptyPid of ptyPids) {
        allPids.push(ptyPid);
        allPids.push(...await this.getAllDescendantPids(ptyPid));
      }

      // Track all PIDs for cache cleanup
      for (const pid of allPids) allTrackedPids.add(pid);

      let children: ChildProcessInfo[];
      if (os.platform() === 'win32') {
        const rawStats = await this.getWindowsBatchRawStats(allPids);
        children = this.resolveProcessStats(allPids, rawStats, now);
      } else {
        const rawStats = await this.getUnixBatchRawStats(allPids);
        children = this.resolveProcessStats(allPids, rawStats, now);
      }

      const totalCpu = children.reduce((sum, c) => sum + c.cpuPercent, 0);
      const totalMem = children.reduce((sum, c) => sum + c.memoryMB, 0);

      sessions.push({
        sessionId,
        sessionName,
        totalCpuPercent: Math.round(totalCpu * 10) / 10,
        totalMemoryMB: Math.round(totalMem * 10) / 10,
        children,
      });
    }

    // Clean up stale CPU samples for processes that no longer exist
    this.cleanupCpuSampleCache(allTrackedPids);

    return sessions;
  }

  async getSnapshot(): Promise<ResourceSnapshot> {
    const cpuReady = !this.needsCpuWarmup;
    // After this poll seeds the cache, the next poll will have real deltas
    if (this.needsCpuWarmup) this.needsCpuWarmup = false;

    const electronProcesses = this.getElectronMetrics();
    const sessions = await this.getSessionMetrics();

    const electronTotal = electronProcesses.reduce(
      (acc, p) => ({ cpu: acc.cpu + p.cpuPercent, mem: acc.mem + p.memoryMB }),
      { cpu: 0, mem: 0 }
    );
    const sessionTotal = sessions.reduce(
      (acc, s) => ({ cpu: acc.cpu + s.totalCpuPercent, mem: acc.mem + s.totalMemoryMB }),
      { cpu: 0, mem: 0 }
    );

    return {
      timestamp: Date.now(),
      cpuReady,
      totalCpuPercent: Math.round((electronTotal.cpu + sessionTotal.cpu) * 10) / 10,
      totalMemoryMB: Math.round((electronTotal.mem + sessionTotal.mem) * 10) / 10,
      electronProcesses,
      sessions,
    };
  }

  startIdlePolling(): void {
    if (this.isHidden) return;
    this.stopAllPolling();
    const poll = async (): Promise<void> => {
      if (this.pollInProgress) return;
      this.pollInProgress = true;
      try {
        const snapshot = await this.getSnapshot();
        this.emit('resource-update', snapshot);
      } catch (error) {
        console.error('[ResourceMonitor] Poll error:', error);
      } finally {
        this.pollInProgress = false;
      }
    };
    void poll();
    this.idleTimer = setInterval(() => void poll(), 180_000);
  }

  startActivePolling(): void {
    if (this.isHidden) {
      this.isActivePolling = true;
      return;
    }
    this.stopAllPolling();
    this.isActivePolling = true;
    const poll = async (): Promise<void> => {
      if (this.pollInProgress) return;
      this.pollInProgress = true;
      try {
        const snapshot = await this.getSnapshot();
        this.emit('resource-update', snapshot);
      } catch (error) {
        console.error('[ResourceMonitor] Poll error:', error);
      } finally {
        this.pollInProgress = false;
      }
    };
    void poll();
    this.activeTimer = setInterval(() => void poll(), 5_000);
  }

  stopActivePolling(): void {
    if (this.isActivePolling) {
      this.isActivePolling = false;
      this.startIdlePolling();
    }
  }

  handleVisibilityChange(hidden: boolean): void {
    this.isHidden = hidden;
    if (hidden) {
      this.stopAllPolling();
      this.previousCpuSamples.clear();
      this.needsCpuWarmup = true;
    } else {
      if (this.isActivePolling) {
        this.startActivePolling();
      } else {
        this.startIdlePolling();
      }
    }
  }

  private stopAllPolling(): void {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    if (this.activeTimer) { clearInterval(this.activeTimer); this.activeTimer = null; }
  }

  stop(): void {
    this.stopAllPolling();
  }
}

export const resourceMonitorService = new ResourceMonitorService();
