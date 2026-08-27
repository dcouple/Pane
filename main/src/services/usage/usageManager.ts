import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { glob } from 'glob';
import chokidar from 'chokidar';
import { databaseService } from '../database';
import { UsageRepository } from './usageRepository';
import { UsageAggregator, resolveReportRange } from './usageAggregator';
import { isFileUnchanged, resolveStartOffset, scanJsonlFile } from './jsonlScanner';
import { PRICING_AS_OF } from './modelPricing';
import {
  DEFAULT_USAGE_RANGE_DAYS,
  USAGE_PARSER_VERSION,
  USAGE_RETENTION_DAYS,
  type UsageIndexStatus,
  type UsageProvider,
  type UsageRateLimitSample,
  type UsageReport,
  type UsageReportRequest,
} from '../../../../shared/types/usage';

interface TranscriptRoot {
  provider: UsageProvider;
  path: string;
}

interface UsageWatcher {
  on(event: 'add' | 'change', listener: (path: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  close(): Promise<void>;
}

type UsageWatchFactory = (
  path: string,
  options: NonNullable<Parameters<typeof chokidar.watch>[1]>,
) => UsageWatcher;

export function createTranscriptWatchers(
  roots: readonly TranscriptRoot[],
  createWatcher: UsageWatchFactory,
  queueFile: (path: string, provider: UsageProvider) => void,
): UsageWatcher[] {
  return roots.map(root => {
    // Missing paths are intentional. Chokidar watches the nearest existing
    // parent and begins reporting once a CLI creates its transcript root.
    const watcher = createWatcher(root.path, {
      ignoreInitial: true,
      depth: 6,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
    });

    const queue = (path: string) => {
      if (path.endsWith('.jsonl')) queueFile(path, root.provider);
    };
    watcher.on('add', queue);
    watcher.on('change', queue);
    watcher.on('error', error => {
      console.warn('[Usage] Watcher error:', error);
    });
    return watcher;
  });
}

/** Yield to the event loop every N files so a first scan never blocks the UI. */
const YIELD_EVERY_FILES = 25;
/** Coalesce watcher events — an active agent appends constantly. */
const WATCH_DEBOUNCE_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;

function transcriptRoots(): TranscriptRoot[] {
  const home = homedir();
  return [
    { provider: 'claude', path: join(home, '.claude', 'projects') },
    { provider: 'codex', path: join(home, '.codex', 'sessions') },
  ];
}

/**
 * Indexes agent CLI transcripts so the usage page can report tokens, cost and
 * rolling-window utilisation.
 *
 * Read-only by construction: it never writes to, creates or deletes anything
 * under `~/.claude` or `~/.codex`.
 *
 * Known limitation: only the Electron host's home directory is scanned. On
 * Windows with WSL-based projects the agents write inside the distro's home,
 * which this does not reach.
 */
class UsageManager {
  // Resolved on first use, not in the constructor: this module is imported at
  // load time and the database handle is only guaranteed after initialisation.
  private repositoryRef: UsageRepository | null = null;
  private aggregatorRef: UsageAggregator | null = null;
  private watchers: UsageWatcher[] = [];
  private pendingFiles = new Map<string, UsageProvider>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private scanning = false;
  private started = false;

  private status: UsageIndexStatus = {
    lastScanStartedMs: null,
    lastScanFinishedMs: null,
    filesTracked: 0,
    eventsIndexed: 0,
    missingRoots: [],
    scanning: false,
    filesScanned: 0,
    filesTotal: 0,
    lastError: null,
  };

  private get repository(): UsageRepository {
    if (!this.repositoryRef) this.repositoryRef = new UsageRepository(databaseService.getDb());
    return this.repositoryRef;
  }

  private get aggregator(): UsageAggregator {
    if (!this.aggregatorRef) this.aggregatorRef = new UsageAggregator(databaseService.getDb());
    return this.aggregatorRef;
  }

  /** Call after `app.whenReady()` — never at module load. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      this.repository.pruneOlderThan(Date.now() - USAGE_RETENTION_DAYS * DAY_MS);
    } catch (error) {
      console.error('[Usage] Retention sweep failed:', error);
    }

    void this.runFullScan();
    this.startWatching();
  }

  stop(): void {
    this.started = false;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const watcher of this.watchers) void watcher.close();
    this.watchers = [];
  }

  getStatus(): UsageIndexStatus {
    return {
      ...this.status,
      filesTracked: this.safeCount(() => this.repository.countFiles()),
      eventsIndexed: this.safeCount(() => this.repository.countEvents()),
    };
  }

  /** Force a full re-scan; used by the page's refresh action. */
  async rescan(): Promise<UsageIndexStatus> {
    await this.runFullScan();
    return this.getStatus();
  }

  getReport(request?: UsageReportRequest): UsageReport {
    const nowMs = Date.now();
    const { fromMs, toMs, bucket } = resolveReportRange(request, nowMs, DEFAULT_USAGE_RANGE_DAYS);
    const providers = request?.providers;

    return {
      totals: this.aggregator.getTotals(fromMs, toMs, providers),
      series: this.aggregator.getSeries(fromMs, toMs, bucket, providers),
      byModel: this.aggregator.getByModel(fromMs, toMs, providers),
      byProject: this.aggregator.getByProject(fromMs, toMs, providers),
      rateLimits: this.safeRateLimits(nowMs, providers),
      index: this.getStatus(),
      pricingAsOf: PRICING_AS_OF,
    };
  }

  /** Quota state, narrowed to the providers the page is showing. */
  private safeRateLimits(nowMs: number, providers?: UsageProvider[]): UsageRateLimitSample[] {
    try {
      const samples = this.repository.getRateLimits(nowMs);
      if (!providers || providers.length === 0) return samples;
      return samples.filter(sample => providers.includes(sample.provider));
    } catch {
      return [];
    }
  }

  private safeCount(read: () => number): number {
    try {
      return read();
    } catch {
      return 0;
    }
  }

  private async runFullScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.status = { ...this.status, scanning: true, lastScanStartedMs: Date.now(), lastError: null, filesScanned: 0 };

    try {
      const roots = transcriptRoots();
      this.status.missingRoots = roots.filter(root => !existsSync(root.path)).map(root => root.path);

      const files: Array<{ path: string; provider: UsageProvider }> = [];
      for (const root of roots) {
        if (!existsSync(root.path)) continue;
        const matches = await glob('**/*.jsonl', { cwd: root.path, absolute: true, nodir: true });
        for (const path of matches) files.push({ path, provider: root.provider });
      }

      this.status.filesTotal = files.length;

      let processed = 0;
      for (const file of files) {
        await this.scanOne(file.path, file.provider);
        processed += 1;
        this.status.filesScanned = processed;
        if (processed % YIELD_EVERY_FILES === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : String(error);
      console.error('[Usage] Scan failed:', error);
    } finally {
      this.scanning = false;
      this.status = { ...this.status, scanning: false, lastScanFinishedMs: Date.now() };
    }
  }

  /**
   * Index one transcript, resuming from its stored cursor. Files whose size
   * and mtime are unchanged are skipped without being opened, which is what
   * makes subsequent launches fast.
   */
  private async scanOne(path: string, provider: UsageProvider): Promise<void> {
    try {
      const stats = await stat(path);
      let recorded = this.repository.getFileCursor(path);

      // A parser fix must reach transcripts that were already indexed, so a
      // version mismatch discards this file's rows and re-reads it in full.
      if (recorded && recorded.parserVersion !== USAGE_PARSER_VERSION) {
        this.repository.forgetFile(path);
        recorded = null;
      }

      if (isFileUnchanged(recorded, stats)) return;

      const startOffset = resolveStartOffset(recorded, stats.size);
      // A file being re-read from the top states its own attribution again, and
      // a stored context would describe bytes that are no longer there — this is
      // the rotation and truncation case.
      const seedContext = startOffset > 0 ? recorded?.parseContext ?? null : null;
      const scanned = await scanJsonlFile(path, provider, startOffset, stats.mtimeMs, seedContext);

      this.repository.commitFile(
        {
          path,
          provider,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          offsetBytes: scanned.nextOffsetBytes,
          lastScannedMs: Date.now(),
          parserVersion: USAGE_PARSER_VERSION,
          parseContext: scanned.context,
        },
        scanned.events,
        Date.now()
      );

      this.repository.recordRateLimits(scanned.rateLimits);
    } catch (error) {
      // A single unreadable transcript must not abort the pass.
      // SAFETY: Node filesystem failures may carry the optional errno code.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        this.repository.forgetFile(path);
        return;
      }
      console.warn(`[Usage] Skipped ${path}:`, error instanceof Error ? error.message : error);
    }
  }

  private startWatching(): void {
    this.watchers = createTranscriptWatchers(
      transcriptRoots(),
      (path, options) => chokidar.watch(path, options),
      (path, provider) => {
        this.pendingFiles.set(path, provider);
        this.scheduleFlush();
      },
    );
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const batch = [...this.pendingFiles.entries()];
      this.pendingFiles.clear();
      void (async () => {
        for (const [path, provider] of batch) {
          await this.scanOne(path, provider);
        }
      })();
    }, WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }
}

export const usageManager = new UsageManager();
