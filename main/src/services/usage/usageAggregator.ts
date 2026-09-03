import { basename } from 'path';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import {
  decodeUsageProvider,
  type UsageBucket,
  type UsageByPane,
  type UsageByPaneReport,
  type UsageByModel,
  type UsageByProject,
  type UsagePaneCostSlice,
  type UsageProvider,
  type UsageReportRequest,
  type UsageTotals,
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
  unmetered_count: number;
}

interface BucketRow extends TokenRow {
  bucket_start_ms: number;
}

interface PaneTokenRow extends TokenRow {
  pane_id: string | null;
}

interface PaneRow {
  id: string;
  name: string;
  worktree_path: string;
  project_id: number | null;
  archived: number | null;
  created_at_ms: number;
}

interface FoldedCostSummary {
  totals: UsageTotals;
  cacheReadCostUsd: number;
}

interface ProviderFilter {
  clause: string;
  params: UsageProvider[];
}

interface ResolvedReportRange {
  fromMs: number;
  toMs: number;
  bucket: 'hour' | 'day';
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    messageCount: 0,
    unmeteredMessageCount: 0,
    estimatedCostUsd: 0,
    costIncomplete: false,
    cacheSavingsUsd: 0,
  };
}

export function emptyPaneCostSlice(options?: { hasCursorPanel?: boolean }): UsagePaneCostSlice {
  const slice: UsagePaneCostSlice = {
    ...emptyTotals(),
    uncachedCostUsd: 0,
    uncachedInputTokens: 0,
    cacheHitRate: 0,
    byModel: [],
  };
  if (options?.hasCursorPanel) slice.costIncomplete = true;
  return slice;
}

function idleCursorPaneSlice(): UsagePaneCostSlice {
  return emptyPaneCostSlice({ hasCursorPanel: true });
}

/**
 * Fold per-model rows into one total, pricing each model separately — a single
 * blended rate would be wrong whenever a range mixes Opus and Haiku traffic.
 */
function foldCostSummary(rows: TokenRow[]): FoldedCostSummary {
  const totals = emptyTotals();
  let cacheReadCostUsd = 0;

  for (const row of rows) {
    if (!decodeUsageProvider(row.provider)) continue;

    const unmetered = row.unmetered_count ?? 0;
    totals.inputTokens += row.input_tokens;
    totals.outputTokens += row.output_tokens;
    totals.cacheReadTokens += row.cache_read_tokens;
    totals.cacheCreationTokens += row.cache_creation_tokens;
    totals.messageCount += row.message_count;
    totals.unmeteredMessageCount += unmetered;

    if (row.message_count > unmetered) {
      const estimate = estimateCostUsd({
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
      });
      totals.estimatedCostUsd += estimate.costUsd;
      totals.cacheSavingsUsd += estimate.cacheSavingsUsd;
      cacheReadCostUsd += estimate.cacheReadCostUsd;
      if (!estimate.complete) totals.costIncomplete = true;
    }

    if (unmetered > 0) totals.costIncomplete = true;
  }

  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  return { totals, cacheReadCostUsd };
}

function foldTotals(rows: TokenRow[]): UsageTotals {
  return foldCostSummary(rows).totals;
}

function foldPaneSlice(rows: TokenRow[]): UsagePaneCostSlice {
  const { totals, cacheReadCostUsd } = foldCostSummary(rows);
  const denominator = totals.inputTokens + totals.cacheReadTokens;
  const byModel = rows.flatMap(row => {
    const provider = decodeUsageProvider(row.provider);
    if (!provider) return [];
    return [{
      model: row.model,
      provider,
      ...foldTotals([row]),
    }];
  }).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  return {
    ...totals,
    uncachedCostUsd: totals.estimatedCostUsd - cacheReadCostUsd,
    uncachedInputTokens: totals.inputTokens,
    cacheHitRate: denominator > 0 ? totals.cacheReadTokens / denominator : 0,
    byModel,
  };
}

const AGGREGATE_COLUMNS = `
  model,
  provider,
  SUM(input_tokens)          AS input_tokens,
  SUM(output_tokens)         AS output_tokens,
  SUM(cache_read_tokens)     AS cache_read_tokens,
  SUM(cache_creation_tokens) AS cache_creation_tokens,
  COUNT(*)                   AS message_count,
  SUM(CASE WHEN metered = 0 THEN 1 ELSE 0 END) AS unmetered_count
`;

export class UsageAggregator {
  constructor(private db: Database) {}

  /**
   * Per-model rollup for a time range. Buckets by model *and* provider so a
   * model id shared across providers stays distinguishable.
   */
  getByModel(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageByModel[] {
    const { clause, params } = this.providerFilter(providers);
    // SAFETY: The fixed projection aliases every column required by TokenRow.
    const rows = this.db.prepare(`
      SELECT ${AGGREGATE_COLUMNS}
      FROM usage_events
      WHERE timestamp_ms >= ? AND timestamp_ms <= ? ${clause}
      GROUP BY model, provider
      ORDER BY SUM(input_tokens + output_tokens) DESC
    `).all(fromMs, toMs, ...params) as TokenRow[];

    return rows.flatMap(row => {
      const provider = decodeUsageProvider(row.provider);
      if (!provider) return [];
      return [{
        model: row.model,
        provider,
        ...foldTotals([row]),
      }];
    });
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
    // SAFETY: The fixed projection aliases every TokenRow field plus cwd.
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

  getByPane(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageByPaneReport {
    const { clause, params } = this.providerFilter(providers);
    // SAFETY: The projection aliases the pane id and every TokenRow field.
    const rows = this.db.prepare(`
      SELECT pane_id, ${AGGREGATE_COLUMNS}
      FROM (
        SELECT
          e.model,
          e.provider,
          e.input_tokens,
          e.output_tokens,
          e.cache_read_tokens,
          e.cache_creation_tokens,
          e.metered,
          COALESCE(
            (
              SELECT p.session_id FROM tool_panels p
              WHERE json_extract(p.state, '$.customState.agentSessionId') = e.agent_session_id
                AND json_extract(p.state, '$.customState.agentType') = 'cursor'
              LIMIT 1
            ),
            (
              SELECT s.id
              FROM sessions s
              WHERE s.worktree_path = e.cwd
                AND e.timestamp_ms >= CAST(strftime('%s', s.created_at) AS INTEGER) * 1000
                AND (
                  s.archived IS NULL OR s.archived = 0
                  OR e.timestamp_ms <= CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000 + 999
                )
              ORDER BY CAST(strftime('%s', s.created_at) AS INTEGER) DESC, s.id
              LIMIT 1
            )
          ) AS pane_id
        FROM usage_events e
        WHERE e.timestamp_ms >= ? AND e.timestamp_ms <= ? ${clause}
      )
      GROUP BY pane_id, model, provider
    `).all(fromMs, toMs, ...params) as PaneTokenRow[];

    const rowsByPane = new Map<string, TokenRow[]>();
    const unattributedRows: TokenRow[] = [];
    for (const row of rows) {
      if (row.pane_id === null) {
        unattributedRows.push(row);
        continue;
      }
      const paneRows = rowsByPane.get(row.pane_id);
      if (paneRows) paneRows.push(row);
      else rowsByPane.set(row.pane_id, [row]);
    }

    // SAFETY: The fixed roster projection is represented by PaneRow.
    const roster = this.db.prepare(`
      SELECT
        id,
        name,
        worktree_path,
        project_id,
        archived,
        CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS created_at_ms
      FROM sessions
      WHERE CAST(strftime('%s', created_at) AS INTEGER) * 1000 <= ?
        AND (
          archived IS NULL OR archived = 0
          OR CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + 999 >= ?
        )
    `).all(toMs, fromMs) as PaneRow[];

    const rosterById = new Map(roster.map(pane => [pane.id, pane]));
    for (const paneId of rowsByPane.keys()) {
      if (rosterById.has(paneId)) continue;
      // SAFETY: The fixed by-id projection is represented by PaneRow and may return no row.
      const pane = this.db.prepare(`
        SELECT
          id,
          name,
          worktree_path,
          project_id,
          archived,
          CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS created_at_ms
        FROM sessions
        WHERE id = ?
      `).get(paneId) as PaneRow | undefined;
      if (pane) rosterById.set(pane.id, pane);
    }

    const cursorPaneIds = this.cursorPaneIds();
    const panes: UsageByPane[] = [...rosterById.values()]
      .map(pane => {
        const paneRows = rowsByPane.get(pane.id);
        return {
          paneId: pane.id,
          paneName: pane.name,
          worktreePath: pane.worktree_path,
          repoId: pane.project_id,
          archived: pane.archived === 1,
          createdAtMs: pane.created_at_ms,
          ...(paneRows
            ? foldPaneSlice(paneRows)
            : cursorPaneIds.has(pane.id) ? idleCursorPaneSlice() : emptyPaneCostSlice()),
        };
      })
      .sort((a, b) => b.uncachedCostUsd - a.uncachedCostUsd || a.paneName.localeCompare(b.paneName));

    return { panes, unattributed: foldPaneSlice(unattributedRows) };
  }

  getTotals(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageTotals {
    const { clause, params } = this.providerFilter(providers);
    // SAFETY: The fixed projection aliases every column required by TokenRow.
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

    // SAFETY: The fixed projection aliases every column required by BucketRow.
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

  private cursorPaneIds(): Set<string> {
    try {
      const rows = this.db.prepare(`
        SELECT DISTINCT session_id AS pane_id
        FROM tool_panels
        WHERE json_extract(state, '$.customState.agentType') = 'cursor'
      `).all() as Array<{ pane_id: string }>;
      return new Set(rows.map(row => row.pane_id));
    } catch {
      return new Set();
    }
  }

  private providerFilter(providers?: UsageProvider[]): ProviderFilter {
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
): ResolvedReportRange {
  const toMs = request?.toMs ?? nowMs;
  const fromMs = request?.fromMs ?? toMs - defaultDays * DAY_MS;
  // An hourly series over months would return thousands of points; pick the
  // bucket from the range unless the caller was explicit.
  const bucket = request?.bucket ?? (toMs - fromMs <= 2 * DAY_MS ? 'hour' : 'day');
  return { fromMs: Math.min(fromMs, toMs), toMs, bucket };
}
