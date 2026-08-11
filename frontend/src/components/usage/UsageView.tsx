import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Loader2, RefreshCw } from 'lucide-react';
import { API } from '../../utils/api';
import { AreaChart } from '../ui/charts/AreaChart';
import { BarChart } from '../ui/charts/BarChart';
import { DonutChart } from '../ui/charts/DonutChart';
import { formatTokens, formatUsd } from '../ui/charts/chartScales';
import { LimitGauge } from './LimitGauge';
import { DEFAULT_USAGE_RANGE_DAYS, type UsageProvider, type UsageReport } from '../../../../shared/types/usage';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Poll while a scan is running so the progress line stays honest. */
const SCAN_POLL_MS = 4000;

const RANGE_OPTIONS = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: DEFAULT_USAGE_RANGE_DAYS, label: '30d' },
  { days: 90, label: '90d' },
] as const;

const PROVIDER_OPTIONS: Array<{ value: UsageProvider | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

const PROVIDER_LABEL: Record<UsageProvider, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
};

const PROVIDER_COLOR: Record<UsageProvider, string> = {
  claude: '#e0913a',
  codex: '#37b877',
};

/** Chart palette, matching the graph view's lane colours. */
const SERIES_COLORS = {
  input: '#4f8ef7',
  output: '#37b877',
  cacheRead: '#8f8ff0',
  cacheWrite: '#e0913a',
} as const;

const MODEL_COLORS = ['#4f8ef7', '#37b877', '#e0913a', '#c765d6', '#e05a6b', '#3fb8c4', '#8f8ff0', '#c2a63a'];

/**
 * The user's own cap for the rolling window, in millions of tokens.
 *
 * Kept client-side: it is a statement about the person's plan, not about the
 * indexed data, and no provider publishes a number Pane could fill in for them.
 */
const WINDOW_LIMIT_KEY = 'pane.usage.windowLimitMTok';

function readStoredLimit(): number | null {
  try {
    const raw = window.localStorage.getItem(WINDOW_LIMIT_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredLimit(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(WINDOW_LIMIT_KEY);
    else window.localStorage.setItem(WINDOW_LIMIT_KEY, String(value));
  } catch {
    // Locked-down profile — the limit just stays session-only.
  }
}

/** "10080" -> "7d", "300" -> "5h" — providers report windows in minutes. */
function formatWindow(minutes: number): string {
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

/** "2h ago" — how old a provider-reported reading is. */
function formatAge(atMs: number): string {
  const elapsed = Date.now() - atMs;
  if (elapsed < 60_000) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatReset(atMs: number): string {
  const remaining = atMs - Date.now();
  if (remaining <= 0) return 'now';
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 24) return `in ${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `in ${hours}h`;
  return `in ${Math.max(1, Math.round(remaining / 60_000))}m`;
}

function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded border border-border-primary bg-surface-secondary px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">{value}</p>
      {detail && <p className="text-[10px] text-text-tertiary">{detail}</p>}
    </div>
  );
}

/**
 * Token usage, cost and rate-limit page.
 *
 * The numbers come from the agent CLIs' own transcripts, indexed in the main
 * process — Pane runs the agents as PTYs and never sees their token accounting
 * directly.
 */
export function UsageView() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState<number>(DEFAULT_USAGE_RANGE_DAYS);
  const [provider, setProvider] = useState<UsageProvider | 'all'>('all');
  /** Series switched off in the legend — see `visibleAreaSeries`. */
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  /**
   * The user's own cap for the rolling window, in millions of tokens.
   *
   * Providers publish no per-plan token cap, so inventing one would be worse
   * than useless — this is the user stating theirs. Null means "compare against
   * my own busiest window", the previous behaviour.
   */
  const [windowLimitMTok, setWindowLimitMTok] = useState<number | null>(() => readStoredLimit());
  const [limitDraft, setLimitDraft] = useState<string>(() => {
    const stored = readStoredLimit();
    return stored === null ? '' : String(stored);
  });

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    if (mode === 'refresh') setRefreshing(true);
    try {
      const toMs = Date.now();
      const response = await API.usage.getReport({
        fromMs: toMs - rangeDays * DAY_MS,
        toMs,
        ...(provider === 'all' ? {} : { providers: [provider] }),
        ...(windowLimitMTok ? { limitTokens: windowLimitMTok * 1_000_000 } : {}),
      });
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to load usage');
      }
      setReport(response.data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load usage');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [rangeDays, provider, windowLimitMTok]);

  /** Apply the typed limit: persist it and reload so the gauge uses it. */
  const applyLimit = useCallback(() => {
    const parsed = Number(limitDraft);
    const next = limitDraft.trim() === '' || !Number.isFinite(parsed) || parsed <= 0
      ? null
      : parsed;
    writeStoredLimit(next);
    setWindowLimitMTok(next);
    setLimitDraft(next === null ? '' : String(next));
  }, [limitDraft]);

  useEffect(() => {
    void load('initial');
  }, [load]);

  // While the index is still building, keep refreshing so numbers fill in.
  const scanning = report?.index.scanning ?? false;
  useEffect(() => {
    if (!scanning) return;
    const timer = window.setInterval(() => { void load('refresh'); }, SCAN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [scanning, load]);

  const handleRescan = useCallback(async () => {
    setRefreshing(true);
    try {
      await API.usage.rescan();
      await load('refresh');
    } catch {
      setRefreshing(false);
    }
  }, [load]);

  const seriesLabels = useMemo(
    () => (report?.series ?? []).map(bucket =>
      new Date(bucket.bucketStartMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    ),
    [report]
  );

  const areaSeries = useMemo(() => {
    const buckets = report?.series ?? [];
    return [
      { label: 'Input', color: SERIES_COLORS.input, values: buckets.map(b => b.inputTokens) },
      { label: 'Output', color: SERIES_COLORS.output, values: buckets.map(b => b.outputTokens) },
      { label: 'Cache read', color: SERIES_COLORS.cacheRead, values: buckets.map(b => b.cacheReadTokens) },
      { label: 'Cache write', color: SERIES_COLORS.cacheWrite, values: buckets.map(b => b.cacheCreationTokens) },
    ];
  }, [report]);

  /**
   * Series the chart is currently drawing.
   *
   * Cache reads run two orders of magnitude above input and output, so on a
   * shared axis those two are a flat line on the floor — the chart looked like
   * it had no input/output data at all. Switching a series off rescales the
   * axis to what is left, which is the only way to see them.
   */
  const visibleAreaSeries = useMemo(
    () => areaSeries.filter(entry => !hiddenSeries.includes(entry.label)),
    [areaSeries, hiddenSeries]
  );

  const toggleSeries = useCallback((label: string) => {
    setHiddenSeries(current => (
      current.includes(label)
        ? current.filter(entry => entry !== label)
        // Never hide the last one: an empty chart says nothing.
        : current.length === areaSeries.length - 1
          ? current
          : [...current, label]
    ));
  }, [areaSeries.length]);

  const modelBars = useMemo(() => {
    const total = report?.totals.totalTokens ?? 0;
    return (report?.byModel ?? []).slice(0, 10).map((entry, index) => ({
      label: entry.model,
      value: entry.totalTokens,
      color: MODEL_COLORS[index % MODEL_COLORS.length],
      tag: PROVIDER_LABEL[entry.provider],
      share: total > 0 ? entry.totalTokens / total : 0,
      detail: entry.costIncomplete ? 'n/a' : formatUsd(entry.estimatedCostUsd),
      // Codex writes the active *profile* where a model id is expected, so a
      // row with no price is usually a sub-agent rather than a missing price.
      note: entry.costIncomplete ? 'no price' : undefined,
      detailTitle: entry.costIncomplete
        ? 'No published price for this id. Codex reports sub-agent profiles (for example codex-auto-review) in the model field, and those are billed under the model they run on.'
        : undefined,
    }));
  }, [report]);

  /** Which worktree spent the tokens — the question only Pane can answer. */
  const projectBars = useMemo(() => {
    const total = report?.totals.totalTokens ?? 0;
    return (report?.byProject ?? []).slice(0, 8).map((entry, index) => ({
      label: entry.label,
      title: entry.path || 'No working directory recorded',
      value: entry.totalTokens,
      color: MODEL_COLORS[index % MODEL_COLORS.length],
      share: total > 0 ? entry.totalTokens / total : 0,
      detail: entry.costIncomplete ? 'n/a' : formatUsd(entry.estimatedCostUsd),
    }));
  }, [report]);

  /**
   * How much of the input never had to be re-read at full price.
   *
   * Cache reads dominate every other number on this page, and as a raw token
   * count that reads as noise. As a hit rate plus the money it saved, it is the
   * most actionable figure here.
   */
  const cacheEfficiency = useMemo(() => {
    const totals = report?.totals;
    if (!totals) return null;
    const readable = totals.inputTokens + totals.cacheReadTokens;
    if (readable === 0) return null;
    return {
      hitRate: totals.cacheReadTokens / readable,
      savingsUsd: totals.cacheSavingsUsd,
    };
  }, [report]);

  /** Anthropic vs OpenAI roll-up — the split the model list alone doesn't show. */
  const providerBars = useMemo(() => {
    const byProvider = new Map<UsageProvider, { tokens: number; cost: number; incomplete: boolean }>();
    for (const entry of report?.byModel ?? []) {
      const acc = byProvider.get(entry.provider) ?? { tokens: 0, cost: 0, incomplete: false };
      acc.tokens += entry.totalTokens;
      acc.cost += entry.estimatedCostUsd;
      acc.incomplete = acc.incomplete || entry.costIncomplete;
      byProvider.set(entry.provider, acc);
    }

    const total = report?.totals.totalTokens ?? 0;
    return [...byProvider.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([key, value]) => ({
        label: PROVIDER_LABEL[key],
        value: value.tokens,
        color: PROVIDER_COLOR[key],
        share: total > 0 ? value.tokens / total : 0,
        detail: value.incomplete ? 'n/a' : formatUsd(value.cost),
      }));
  }, [report]);

  const cacheSlices = useMemo(() => {
    const totals = report?.totals;
    if (!totals) return [];
    return [
      { label: 'Input', value: totals.inputTokens, color: SERIES_COLORS.input },
      { label: 'Output', value: totals.outputTokens, color: SERIES_COLORS.output },
      { label: 'Cache read', value: totals.cacheReadTokens, color: SERIES_COLORS.cacheRead },
      { label: 'Cache write', value: totals.cacheCreationTokens, color: SERIES_COLORS.cacheWrite },
    ];
  }, [report]);

  const bothRootsMissing = (report?.index.missingRoots.length ?? 0) >= 2;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
          <h1 className="text-sm font-medium text-text-primary">Usage &amp; limits</h1>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">Provider</legend>
            {PROVIDER_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={provider === option.value}
                onClick={() => setProvider(option.value)}
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  provider === option.value
                    ? 'bg-interactive text-text-on-interactive'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                {option.label}
              </button>
            ))}
          </fieldset>

          <span className="h-4 w-px bg-border-primary" aria-hidden="true" />

          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">Time range</legend>
            {RANGE_OPTIONS.map(option => (
              <button
                key={option.days}
                type="button"
                aria-pressed={rangeDays === option.days}
                onClick={() => setRangeDays(option.days)}
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  rangeDays === option.days
                    ? 'bg-interactive text-text-on-interactive'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                {option.label}
              </button>
            ))}
          </fieldset>

          <button
            type="button"
            onClick={() => { void handleRescan(); }}
            disabled={refreshing}
            aria-label="Rescan transcripts"
            className="rounded p-1 transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-text-tertiary ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </header>

      {report?.index.scanning && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-primary bg-surface-tertiary px-4 py-1 text-[11px] text-text-tertiary">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Indexing transcripts… {report.index.filesScanned}/{report.index.filesTotal} files
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Reading usage…
          </div>
        ) : error ? (
          <div className="rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">
            {error}
          </div>
        ) : bothRootsMissing ? (
          <div className="mx-auto max-w-lg rounded border border-border-primary bg-surface-secondary p-6 text-center">
            <h2 className="mb-2 text-sm font-medium text-text-primary">No agent transcripts found</h2>
            <p className="text-xs text-text-secondary">
              Usage is read from the Claude Code and Codex transcript files in your home directory.
              Neither <code className="font-mono">~/.claude/projects</code> nor{' '}
              <code className="font-mono">~/.codex/sessions</code> exists yet — run an agent once and
              come back.
            </p>
          </div>
        ) : report ? (
          <div className="mx-auto flex max-w-6xl flex-col gap-4">
            {/* Summary */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard
                label="Total tokens"
                value={formatTokens(report.totals.totalTokens)}
                detail={`${report.totals.messageCount.toLocaleString()} messages`}
              />
              <StatCard label="Input" value={formatTokens(report.totals.inputTokens)} />
              <StatCard label="Output" value={formatTokens(report.totals.outputTokens)} />
              {/*
                Not a bill. These tokens were almost certainly paid for by a
                flat-rate plan; the figure is what the same traffic would cost
                billed per token through the APIs, which is the only number the
                transcripts support.
              */}
              <StatCard
                label="At API prices"
                value={formatUsd(report.totals.estimatedCostUsd)}
                detail={report.totals.costIncomplete
                  ? 'What API billing would cost · some ids unpriced'
                  : 'What API billing would cost, not your plan'}
              />
            </div>

            {cacheEfficiency && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard
                  label="Cache hit rate"
                  value={`${Math.round(cacheEfficiency.hitRate * 100)}%`}
                  detail="of read input came from cache"
                />
                <StatCard
                  label="Saved by caching"
                  value={formatUsd(cacheEfficiency.savingsUsd)}
                  detail="vs. re-reading at full input price"
                />
                <StatCard
                  label="Messages"
                  value={report.totals.messageCount.toLocaleString()}
                  detail={`${formatTokens(
                    report.totals.messageCount > 0
                      ? report.totals.totalTokens / report.totals.messageCount
                      : 0
                  )} per message`}
                />
                <StatCard
                  label="Busiest project"
                  value={report.byProject[0]?.label ?? '—'}
                  detail={report.byProject[0]
                    ? `${formatTokens(report.byProject[0].totalTokens)} tokens`
                    : undefined}
                />
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-3">
              {/* Time series */}
              <section className="rounded border border-border-primary bg-surface-secondary p-3 lg:col-span-2">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  Tokens over time
                </h2>
                <AreaChart
                  labels={seriesLabels}
                  series={visibleAreaSeries}
                  formatValue={formatTokens}
                  ariaLabel={`Token usage over the last ${rangeDays} days, totalling ${formatTokens(report.totals.totalTokens)} tokens`}
                />
                {/*
                  A legend that switches series on and off, because the axis is
                  shared: with cache reads drawn, input and output are a flat
                  line on the floor.
                */}
                <ul className="mt-2 flex flex-wrap gap-2">
                  {areaSeries.map(entry => {
                    const hidden = hiddenSeries.includes(entry.label);
                    const total = entry.values.reduce((sum, value) => sum + value, 0);

                    return (
                      <li key={entry.label}>
                        <button
                          type="button"
                          onClick={() => toggleSeries(entry.label)}
                          aria-pressed={!hidden}
                          title={hidden ? `Show ${entry.label}` : `Hide ${entry.label}`}
                          className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-interactive ${
                            hidden ? 'text-text-muted' : 'text-text-tertiary'
                          }`}
                        >
                          <span
                            className="h-2 w-2 rounded-sm border"
                            style={{
                              backgroundColor: hidden ? 'transparent' : entry.color,
                              borderColor: entry.color,
                            }}
                            aria-hidden="true"
                          />
                          <span className={hidden ? 'line-through' : undefined}>{entry.label}</span>
                          <span className="tabular-nums text-text-muted">{formatTokens(total)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Limits */}
              <section className="rounded border border-border-primary bg-surface-secondary p-3">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  Limits
                </h2>

                {/* Provider-reported quota beats anything we could infer. */}
                {report.rateLimits.length > 0 && (
                  <ul className="mb-3 space-y-2">
                    {report.rateLimits.map(limit => (
                      <li key={`${limit.provider}-${limit.limitId}-${limit.scope}`}>
                        <div className="flex items-baseline justify-between gap-2 text-[11px]">
                          <span className="truncate text-text-secondary">
                            {PROVIDER_LABEL[limit.provider]}
                            {limit.windowMinutes && (
                              <span className="ml-1 text-text-muted">
                                {formatWindow(limit.windowMinutes)}
                              </span>
                            )}
                            {limit.planType && (
                              <span className="ml-1 text-text-muted">· {limit.planType}</span>
                            )}
                          </span>
                          <span className="flex-shrink-0 tabular-nums text-text-primary">
                            {Math.round(limit.usedPercent)}%
                          </span>
                        </div>
                        <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(Math.max(limit.usedPercent, 0), 100)}%`,
                              backgroundColor: limit.usedPercent >= 90
                                ? 'var(--color-status-error, #e05a6b)'
                                : limit.usedPercent >= 70
                                  ? 'var(--color-status-warning, #e0913a)'
                                  : 'var(--color-status-success, #37b877)',
                            }}
                          />
                        </div>
                        {/*
                          When the reading was taken matters as much as the
                          reading: these come from the last transcript line the
                          agent wrote, and a 0% from yesterday is not a claim
                          about now.
                        */}
                        <p className="mt-0.5 text-[10px] text-text-muted">
                          Reported {formatAge(limit.capturedAtMs)}
                          {limit.resetsAtMs
                            ? limit.resetsAtMs <= Date.now()
                              ? ' · window has since reset'
                              : ` · resets ${formatReset(limit.resetsAtMs)}`
                            : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}

                <LimitGauge window={report.window} />

                {/*
                  The window cap is the user's to state — no provider publishes
                  a per-plan token number, and the gauge is guesswork until
                  someone says what it is measuring against.
                */}
                <div className="mt-3 border-t border-border-primary pt-2">
                  <label
                    htmlFor="usage-window-limit"
                    className="text-[10px] uppercase tracking-wider text-text-muted"
                  >
                    My {report.window.windowHours}h limit
                  </label>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      id="usage-window-limit"
                      type="number"
                      min={0}
                      step={10}
                      inputMode="decimal"
                      value={limitDraft}
                      placeholder="auto"
                      onChange={event => setLimitDraft(event.target.value)}
                      onBlur={applyLimit}
                      onKeyDown={event => { if (event.key === 'Enter') applyLimit(); }}
                      className="w-24 rounded border border-border-secondary bg-surface-primary px-1.5 py-0.5 text-[11px] tabular-nums text-text-primary focus:border-interactive focus:outline-none"
                    />
                    <span className="text-[10px] text-text-muted">million tokens</span>
                    {windowLimitMTok !== null && (
                      <button
                        type="button"
                        onClick={() => { setLimitDraft(''); writeStoredLimit(null); setWindowLimitMTok(null); }}
                        className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <section className="rounded border border-border-primary bg-surface-secondary p-3 lg:col-span-2">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  By model
                </h2>
                <BarChart
                  data={modelBars}
                  formatValue={formatTokens}
                  ariaLabel="Token usage broken down by model"
                />

                <h2 className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  By project
                </h2>
                <BarChart
                  data={projectBars}
                  formatValue={formatTokens}
                  ariaLabel="Token usage broken down by working directory"
                />
              </section>

              <section className="rounded border border-border-primary bg-surface-secondary p-3">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  By provider
                </h2>
                <BarChart
                  data={providerBars}
                  formatValue={formatTokens}
                  ariaLabel="Token usage split between Anthropic and OpenAI"
                />

                <h2 className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  Token mix
                </h2>
                <DonutChart
                  slices={cacheSlices}
                  formatValue={formatTokens}
                  ariaLabel="Share of input, output and cache tokens"
                  centerLabel={formatTokens(report.totals.totalTokens)}
                  centerSublabel="tokens"
                />
              </section>
            </div>

            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-text-muted">
              <span>Prices as of {report.pricingAsOf}; costs are estimates.</span>
              <span>{report.index.eventsIndexed.toLocaleString()} messages indexed from {report.index.filesTracked.toLocaleString()} transcripts.</span>
              {/* The scanner reads this machine's home only; WSL distros keep their own. */}
              <span>Agents running inside WSL write their transcripts in the distro’s home and are not counted.</span>
              {report.index.missingRoots.length > 0 && (
                <span>Not found: {report.index.missingRoots.join(', ')}</span>
              )}
              {report.index.lastError && (
                <span className="text-status-warning">Last scan error: {report.index.lastError}</span>
              )}
            </footer>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default UsageView;
