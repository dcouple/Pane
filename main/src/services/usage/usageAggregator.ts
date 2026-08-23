import { basename } from 'path';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import {
  USAGE_WINDOW_HOURS,
  type UsageBucket,
  type UsageByModel,
  type UsageByProject,
  type UsageProvider,
  type UsageReportRequest,
  type UsageTotals,
  type UsageWindow,
} from '../../../../shared/types/usage';
import { estimateCostUsd } from './modelPricing';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface TokenRow {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  message_count: number;
}

interface BucketRow extends TokenRow {
  bucket_start_ms: number;
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    messageCount: 0,
    estimatedCostUsd: 0,
    costIncomplete: false,
    cacheSavingsUsd: 0,
  };
}

/**
 * Fold per-model rows into one total, pricing each model separately — a single
 * blended rate would be wrong whenever a range mixes Opus and Haiku traffic.
 */
function foldTotals(rows: TokenRow[]): UsageTotals {
  const totals = emptyTotals();

  for (const row of rows) {
    totals.inputTokens += row.input_tokens;
    totals.outputTokens += row.output_tokens;
    totals.cacheReadTokens += row.cache_read_tokens;
    totals.cacheCreationTokens += row.cache_creation_tokens;
    totals.messageCount += row.message_count;

    const { costUsd, complete, cacheSavingsUsd } = estimateCostUsd({
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
    });
    totals.estimatedCostUsd += costUsd;
    totals.cacheSavingsUsd += cacheSavingsUsd;
    if (!complete) totals.costIncomplete = true;
  }

  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  return totals;
}

const AGGREGATE_COLUMNS = `
  model,
  provider,
  SUM(input_tokens)          AS input_tokens,
  SUM(output_tokens)         AS output_tokens,
  SUM(cache_read_tokens)     AS cache_read_tokens,
  SUM(cache_creation_tokens) AS cache_creation_tokens,
  COUNT(*)                   AS message_count
`;

export class UsageAggregator {
  constructor(private db: Database) {}

  /**
   * Per-model rollup for a time range. Buckets by model *and* provider so a
   * model id shared across providers stays distinguishable.
   */
  getByModel(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageByModel[] {
    const { clause, params } = this.providerFilter(providers);
    const rows = this.db.prepare(`
      SELECT ${AGGREGATE_COLUMNS}
      FROM usage_events
      WHERE timestamp_ms >= ? AND timestamp_ms <= ? ${clause}
      GROUP BY model, provider
      ORDER BY SUM(input_tokens + output_tokens) DESC
    `).all(fromMs, toMs, ...params) as TokenRow[];

    return rows.map(row => ({
      model: row.model,
      provider: row.provider === 'codex' ? 'codex' : 'claude',
      ...foldTotals([row]),
    }));
  }

  /**
   * Per-directory rollup — "which worktree spent my quota".
   *
   * The transcripts know nothing about Pane's sessions; the working directory
   * each message recorded is the only link back to a project, so that is what
   * is grouped on. Rows without a cwd are folded into one "Unknown" entry
   * rather than dropped, so the parts still sum to the whole.
   */
  getByProject(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageByProject[] {
    const { clause, params } = this.providerFilter(providers);
    const rows = this.db.prepare(`
      SELECT cwd, ${AGGREGATE_COLUMNS}
      FROM usage_events
      WHERE timestamp_ms >= ? AND timestamp_ms <= ? ${clause}
      GROUP BY cwd, model, provider
    `).all(fromMs, toMs, ...params) as Array<TokenRow & { cwd: string | null }>;

    const byPath = new Map<string, TokenRow[]>();
    for (const row of rows) {
      const path = row.cwd && row.cwd.trim().length > 0 ? row.cwd : '';
      const existing = byPath.get(path);
      if (existing) existing.push(row);
      else byPath.set(path, [row]);
    }

    return [...byPath.entries()]
      .map(([path, pathRows]) => ({
        path,
        label: path ? basename(path) || path : 'Unknown',
        ...foldTotals(pathRows),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  getTotals(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageTotals {
    const { clause, params } = this.providerFilter(providers);
    const rows = this.db.prepare(`
      SELECT ${AGGREGATE_COLUMNS}
      FROM usage_events
      WHERE timestamp_ms >= ? AND timestamp_ms <= ? ${clause}
      GROUP BY model, provider
    `).all(fromMs, toMs, ...params) as TokenRow[];

    return foldTotals(rows);
  }

  /**
   * Time series. Bucketing is arithmetic on the epoch value rather than
   * `strftime`, so it never depends on the SQLite build's timezone handling.
   */
  getSeries(
    fromMs: number,
    toMs: number,
    bucket: 'hour' | 'day',
    providers?: UsageProvider[]
  ): UsageBucket[] {
    const bucketMs = bucket === 'hour' ? HOUR_MS : DAY_MS;
    const { clause, params } = this.providerFilter(providers);

    const rows = this.db.prepare(`
      SELECT
        (timestamp_ms / ${bucketMs}) * ${bucketMs} AS bucket_start_ms,
        ${AGGREGATE_COLUMNS}
      FROM usage_events
      WHERE timestamp_ms >= ? AND timestamp_ms <= ? ${clause}
      GROUP BY bucket_start_ms, model, provider
      ORDER BY bucket_start_ms ASC
    `).all(fromMs, toMs, ...params) as BucketRow[];

    const byBucket = new Map<number, TokenRow[]>();
    for (const row of rows) {
      const existing = byBucket.get(row.bucket_start_ms);
      if (existing) existing.push(row);
      else byBucket.set(row.bucket_start_ms, [row]);
    }

    return [...byBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucketStartMs, bucketRows]) => ({ bucketStartMs, ...foldTotals(bucketRows) }));
  }

  /**
   * Rolling-window utilisation — "how much of my quota is left".
   *
   * When no explicit limit is configured, the largest window ever observed is
   * used as a proxy: it is a lower bound on the real cap, which makes the
   * gauge useful without inventing a number.
   */
  getWindow(
    nowMs: number,
    configuredLimitTokens: number | null,
    providers?: UsageProvider[],
  ): UsageWindow {
    const windowMs = USAGE_WINDOW_HOURS * HOUR_MS;
    const windowStartMs = nowMs - windowMs;
    const totals = this.getTotals(windowStartMs, nowMs, providers);
    const { clause, params } = this.providerFilter(providers);

    const oldest = this.db.prepare(`
      SELECT MIN(timestamp_ms) AS oldest
      FROM usage_events
      WHERE timestamp_ms >= ? ${clause}
    `).get(windowStartMs, ...params) as { oldest: number | null };

    let limitTokens = configuredLimitTokens;
    let limitSource: UsageWindow['limitSource'] = configuredLimitTokens ? 'configured' : 'unknown';

    if (!limitTokens) {
      const observed = this.getObservedMaxWindowTokens(windowMs, providers);
      if (observed > 0) {
        limitTokens = observed;
        limitSource = 'observed-max';
      }
    }

    return {
      windowHours: USAGE_WINDOW_HOURS,
      windowStartMs,
      windowEndMs: nowMs,
      totals,
      limitTokens: limitTokens ?? null,
      limitSource,
      utilization: limitTokens ? Math.min(totals.totalTokens / limitTokens, 1) : null,
      resetsAtMs: oldest.oldest ? oldest.oldest + windowMs : null,
      recentHourTokens: this.getTotals(nowMs - HOUR_MS, nowMs, providers).totalTokens,
    };
  }

  /**
   * Largest token count seen in any historical window, approximated by
   * bucketing on window boundaries. Exact sliding maxima would require a scan
   * over every event; the bucketed figure is close enough for a gauge.
   */
  private getObservedMaxWindowTokens(windowMs: number, providers?: UsageProvider[]): number {
    const { clause, params } = this.providerFilter(providers);
    const row = this.db.prepare(`
      SELECT MAX(window_tokens) AS peak FROM (
        SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS window_tokens
        FROM usage_events
        WHERE 1 = 1 ${clause}
        GROUP BY timestamp_ms / ${windowMs}
      )
    `).get(...params) as { peak: number | null };

    return row.peak ?? 0;
  }

  private providerFilter(providers?: UsageProvider[]): { clause: string; params: string[] } {
    if (!providers || providers.length === 0) return { clause: '', params: [] };
    const placeholders = providers.map(() => '?').join(', ');
    return { clause: `AND provider IN (${placeholders})`, params: [...providers] };
  }
}

/** Normalise a report request into a concrete, bounded range. */
export function resolveReportRange(
  request: UsageReportRequest | undefined,
  nowMs: number,
  defaultDays: number
): { fromMs: number; toMs: number; bucket: 'hour' | 'day' } {
  const toMs = request?.toMs ?? nowMs;
  const fromMs = request?.fromMs ?? toMs - defaultDays * DAY_MS;
  // An hourly series over months would return thousands of points; pick the
  // bucket from the range unless the caller was explicit.
  const bucket = request?.bucket ?? (toMs - fromMs <= 2 * DAY_MS ? 'hour' : 'day');
  return { fromMs: Math.min(fromMs, toMs), toMs, bucket };
}
