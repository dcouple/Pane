/**
 * Token usage, cost and rate-limit types.
 *
 * Pane runs Claude and Codex as PTY terminals, so no structured usage flows
 * through the app itself. The authoritative record is each CLI's own transcript
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/sessions/**\/*.jsonl`), which
 * Pane reads read-only and indexes incrementally.
 */

export type UsageProvider = 'claude' | 'codex';

/** One assistant message's token accounting, normalised across providers. */
export interface UsageEvent {
  provider: UsageProvider;
  /** Epoch milliseconds — the indexed column. */
  timestampMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Provider session id from the transcript, when present. */
  agentSessionId: string | null;
  /** Message id — the primary dedupe key across re-scans. */
  messageId: string | null;
  /** Working directory recorded in the transcript, for project attribution. */
  cwd: string | null;
}

export interface ModelPrice {
  model: string;
  /** USD per 1M tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  messageCount: number;
  estimatedCostUsd: number;
  /** True when at least one model in the range had no price entry. */
  costIncomplete: boolean;
  /**
   * What the cached input would have cost at the full input rate, minus what
   * it did cost. With cache reads running two orders of magnitude above fresh
   * input, this is the single largest lever on the bill.
   */
  cacheSavingsUsd: number;
}

export interface UsageBucket extends UsageTotals {
  /** Bucket start, epoch milliseconds. */
  bucketStartMs: number;
}

export interface UsageByModel extends UsageTotals {
  model: string;
  provider: UsageProvider;
}

/**
 * Usage attributed to the directory the agent ran in.
 *
 * Both CLIs record their working directory per message, which is the only
 * link back to a Pane project or worktree — the transcripts know nothing about
 * Pane's own session model.
 */
export interface UsageByProject extends UsageTotals {
  /** Absolute working directory as the transcript recorded it. */
  path: string;
  /** Last path segment — the worktree or repo folder name. */
  label: string;
}

/** Rolling-window utilisation, the "how much limit is left" figure. */
export interface UsageWindow {
  windowHours: number;
  windowStartMs: number;
  windowEndMs: number;
  totals: UsageTotals;
  /** Configured cap, or the largest window observed historically. */
  limitTokens: number | null;
  limitSource: 'configured' | 'observed-max' | 'unknown';
  /** 0..1, or null when no limit is known. */
  utilization: number | null;
  /** When the oldest event in the window ages out, epoch milliseconds. */
  resetsAtMs: number | null;
  /**
   * Tokens in the last hour — the current pace, as opposed to the window's
   * average. A window that is 10% full but filling fast is a different
   * situation from one that is 10% full and idle.
   */
  recentHourTokens: number;
}

export interface UsageReportRequest {
  /** Inclusive epoch-ms range. Defaults to the last 30 days. */
  fromMs?: number;
  toMs?: number;
  bucket?: 'hour' | 'day';
  providers?: UsageProvider[];
  /**
   * The user's own cap for the rolling window, in tokens. Without one the
   * gauge compares against the largest window ever observed, which flatters
   * a heavy day and understates a quiet one.
   */
  limitTokens?: number | null;
}

/** Health of the background transcript index, surfaced in the page header. */
export interface UsageIndexStatus {
  lastScanStartedMs: number | null;
  lastScanFinishedMs: number | null;
  filesTracked: number;
  eventsIndexed: number;
  /** Transcript roots that do not exist — drives the empty state. */
  missingRoots: string[];
  scanning: boolean;
  /** Files scanned so far in the current pass, for a progress indicator. */
  filesScanned: number;
  filesTotal: number;
  lastError: string | null;
}

/**
 * A rate limit as the provider itself reported it.
 *
 * Codex writes its live quota state into every `token_count` event, which
 * makes this a measured figure rather than an estimate. Claude Code's
 * transcripts carry no equivalent, so Claude falls back to
 * {@link UsageWindow}'s computed rolling window.
 */
export interface UsageRateLimitSample {
  provider: UsageProvider;
  limitId: string;
  scope: 'primary' | 'secondary';
  /** 0-100, as reported. */
  usedPercent: number;
  windowMinutes: number | null;
  resetsAtMs: number | null;
  /** Subscription tier, when the provider names it. */
  planType: string | null;
  capturedAtMs: number;
}

export interface UsageReport {
  totals: UsageTotals;
  series: UsageBucket[];
  byModel: UsageByModel[];
  /** Busiest working directories in the range, largest first. */
  byProject: UsageByProject[];
  window: UsageWindow;
  /** Provider-reported quota state; empty when nobody reported any. */
  rateLimits: UsageRateLimitSample[];
  index: UsageIndexStatus;
  /** Date the bundled price table was last verified, shown in the footer. */
  pricingAsOf: string;
}

/**
 * Bumped whenever the transcript parsers change in a way that alters the
 * events they produce. Files indexed by an older parser are re-read from the
 * start instead of being silently trusted — otherwise a fix would only apply
 * to transcripts written after it.
 *
 * v2: Codex `token_count` events parsed from `last_token_usage` (v1 read the
 *     wrong shape entirely and recorded nothing).
 */
export const USAGE_PARSER_VERSION = 2;

/** Claude's published quota window, and the one ccusage-style tools track. */
export const USAGE_WINDOW_HOURS = 5;
export const DEFAULT_USAGE_RANGE_DAYS = 30;
/** Events older than this are swept at startup to bound the table. */
export const USAGE_RETENTION_DAYS = 180;
