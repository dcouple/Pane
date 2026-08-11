import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { UsageAggregator, resolveReportRange } from './usageAggregator';
import { USAGE_WINDOW_HOURS } from '../../../../shared/types/usage';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 4, 15, 12, 0, 0);

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      agent_session_id TEXT,
      cwd TEXT,
      source_path TEXT NOT NULL
    );
  `);
  return db;
}

let db: ReturnType<typeof createDb>;
let aggregator: UsageAggregator;
let seq = 0;

function seed(options: {
  timestampMs: number;
  model?: string;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}) {
  seq += 1;
  db.prepare(`
    INSERT INTO usage_events (id, provider, timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `e${seq}`,
    options.provider ?? 'claude',
    options.timestampMs,
    options.model ?? 'claude-sonnet-5',
    options.input ?? 0,
    options.output ?? 0,
    options.cacheRead ?? 0,
    options.cacheWrite ?? 0,
    '/t.jsonl'
  );
}

beforeEach(() => {
  db = createDb();
  aggregator = new UsageAggregator(db);
  seq = 0;
});

describe('UsageAggregator.getTotals', () => {
  it('returns zeroed totals for an empty database', () => {
    const totals = aggregator.getTotals(0, NOW);
    expect(totals.totalTokens).toBe(0);
    expect(totals.messageCount).toBe(0);
    expect(totals.estimatedCostUsd).toBe(0);
    expect(totals.costIncomplete).toBe(false);
  });

  it('sums every token category and counts messages', () => {
    seed({ timestampMs: NOW - HOUR_MS, input: 100, output: 50, cacheRead: 20, cacheWrite: 10 });
    seed({ timestampMs: NOW - 2 * HOUR_MS, input: 200, output: 60 });

    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);

    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(110);
    expect(totals.cacheReadTokens).toBe(20);
    expect(totals.cacheCreationTokens).toBe(10);
    expect(totals.totalTokens).toBe(440);
    expect(totals.messageCount).toBe(2);
  });

  it('excludes events outside the requested range', () => {
    seed({ timestampMs: NOW - 40 * DAY_MS, input: 1000 });
    seed({ timestampMs: NOW - HOUR_MS, input: 10 });

    expect(aggregator.getTotals(NOW - 30 * DAY_MS, NOW).inputTokens).toBe(10);
  });

  it('flags costs as incomplete when a model has no price entry', () => {
    seed({ timestampMs: NOW - HOUR_MS, model: 'some-unlisted-model', input: 100, output: 10 });

    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);
    expect(totals.costIncomplete).toBe(true);
    expect(totals.estimatedCostUsd).toBe(0);
  });

  it('prices each model separately rather than blending rates', () => {
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-opus-5', input: 1_000_000 });
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-sonnet-5', input: 1_000_000 });

    // Opus input is $15/Mtok and Sonnet $3/Mtok.
    expect(aggregator.getTotals(NOW - DAY_MS, NOW).estimatedCostUsd).toBeCloseTo(18, 6);
  });

  it('prices OpenAI / Codex models, not just Claude', () => {
    // gpt-5-codex: $1.25/Mtok input, $10/Mtok output.
    seed({ timestampMs: NOW - HOUR_MS, provider: 'codex', model: 'gpt-5-codex', input: 1_000_000, output: 1_000_000 });

    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);
    expect(totals.costIncomplete).toBe(false);
    expect(totals.estimatedCostUsd).toBeCloseTo(11.25, 6);
  });

  it('resolves dated and versioned OpenAI ids to their base model', () => {
    // Longest-prefix matching must pick gpt-5.3-codex, not the shorter gpt-5.
    seed({ timestampMs: NOW - HOUR_MS, provider: 'codex', model: 'gpt-5.3-codex-20260224', input: 1_000_000 });

    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);
    expect(totals.costIncomplete).toBe(false);
    expect(totals.estimatedCostUsd).toBeCloseTo(1.75, 6);
  });

  it('filters by provider when asked', () => {
    seed({ timestampMs: NOW - HOUR_MS, provider: 'claude', input: 10 });
    seed({ timestampMs: NOW - HOUR_MS, provider: 'codex', model: 'gpt-5-codex', input: 90 });

    expect(aggregator.getTotals(NOW - DAY_MS, NOW, ['claude']).inputTokens).toBe(10);
    expect(aggregator.getTotals(NOW - DAY_MS, NOW, ['codex']).inputTokens).toBe(90);
  });
});

describe('UsageAggregator.getByModel', () => {
  it('groups by model and orders by volume', () => {
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-sonnet-5', input: 10 });
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-opus-5', input: 500 });

    const byModel = aggregator.getByModel(NOW - DAY_MS, NOW);

    expect(byModel).toHaveLength(2);
    expect(byModel[0].model).toBe('claude-opus-5');
    expect(byModel[0].provider).toBe('claude');
  });
});

describe('UsageAggregator.getSeries', () => {
  it('returns no buckets when there is no data', () => {
    expect(aggregator.getSeries(NOW - DAY_MS, NOW, 'day')).toEqual([]);
  });

  it('collapses events into hourly buckets', () => {
    seed({ timestampMs: NOW - 90 * 60 * 1000, input: 10 });
    seed({ timestampMs: NOW - 80 * 60 * 1000, input: 20 });
    seed({ timestampMs: NOW - 10 * 60 * 1000, input: 5 });

    const series = aggregator.getSeries(NOW - DAY_MS, NOW, 'hour');

    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series.every((bucket, i) => i === 0 || bucket.bucketStartMs > series[i - 1].bucketStartMs)).toBe(true);
    expect(series.reduce((sum, bucket) => sum + bucket.inputTokens, 0)).toBe(35);
  });

  it('merges several models within one bucket into a single point', () => {
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-opus-5', input: 10 });
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-sonnet-5', input: 20 });

    const series = aggregator.getSeries(NOW - DAY_MS, NOW, 'hour');
    const bucket = series.find(entry => entry.inputTokens === 30);
    expect(bucket).toBeDefined();
    expect(bucket?.messageCount).toBe(2);
  });

  it('buckets by day when asked', () => {
    seed({ timestampMs: NOW - 2 * DAY_MS, input: 10 });
    seed({ timestampMs: NOW - 2 * DAY_MS + HOUR_MS, input: 10 });

    const series = aggregator.getSeries(NOW - 7 * DAY_MS, NOW, 'day');
    expect(series).toHaveLength(1);
    expect(series[0].inputTokens).toBe(20);
  });
});

describe('UsageAggregator.getWindow', () => {
  it('counts only events inside the rolling window', () => {
    seed({ timestampMs: NOW - (USAGE_WINDOW_HOURS + 1) * HOUR_MS, input: 1000 });
    seed({ timestampMs: NOW - HOUR_MS, input: 25 });

    const window = aggregator.getWindow(NOW, null);

    expect(window.windowHours).toBe(USAGE_WINDOW_HOURS);
    expect(window.totals.inputTokens).toBe(25);
  });

  it('uses a configured limit and reports utilisation', () => {
    seed({ timestampMs: NOW - HOUR_MS, input: 250 });

    const window = aggregator.getWindow(NOW, 1000);

    expect(window.limitSource).toBe('configured');
    expect(window.limitTokens).toBe(1000);
    expect(window.utilization).toBeCloseTo(0.25, 6);
  });

  it('clamps utilisation at 1 when usage exceeds the limit', () => {
    seed({ timestampMs: NOW - HOUR_MS, input: 5000 });
    expect(aggregator.getWindow(NOW, 1000).utilization).toBe(1);
  });

  it('falls back to the largest observed window when no limit is configured', () => {
    seed({ timestampMs: NOW - 40 * DAY_MS, input: 900 });
    seed({ timestampMs: NOW - HOUR_MS, input: 100 });

    const window = aggregator.getWindow(NOW, null);

    expect(window.limitSource).toBe('observed-max');
    expect(window.limitTokens).toBe(900);
  });

  it('reports an unknown limit and no utilisation for an empty database', () => {
    const window = aggregator.getWindow(NOW, null);

    expect(window.limitSource).toBe('unknown');
    expect(window.limitTokens).toBeNull();
    expect(window.utilization).toBeNull();
    expect(window.resetsAtMs).toBeNull();
  });

  it('reports when the oldest event in the window ages out', () => {
    const oldest = NOW - 2 * HOUR_MS;
    seed({ timestampMs: oldest, input: 10 });

    expect(aggregator.getWindow(NOW, null).resetsAtMs).toBe(oldest + USAGE_WINDOW_HOURS * HOUR_MS);
  });
});

describe('resolveReportRange', () => {
  it('defaults to the trailing window ending now', () => {
    const range = resolveReportRange(undefined, NOW, 30);
    expect(range.toMs).toBe(NOW);
    expect(range.fromMs).toBe(NOW - 30 * DAY_MS);
  });

  it('picks hourly buckets for short ranges and daily for long ones', () => {
    expect(resolveReportRange({ fromMs: NOW - DAY_MS, toMs: NOW }, NOW, 30).bucket).toBe('hour');
    expect(resolveReportRange({ fromMs: NOW - 30 * DAY_MS, toMs: NOW }, NOW, 30).bucket).toBe('day');
  });

  it('honours an explicit bucket', () => {
    expect(resolveReportRange({ fromMs: NOW - 30 * DAY_MS, toMs: NOW, bucket: 'hour' }, NOW, 30).bucket).toBe('hour');
  });

  it('never returns an inverted range', () => {
    const range = resolveReportRange({ fromMs: NOW, toMs: NOW - DAY_MS }, NOW, 30);
    expect(range.fromMs).toBeLessThanOrEqual(range.toMs);
  });
});
