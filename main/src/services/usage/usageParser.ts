import type { UsageEvent, UsageProvider, UsageRateLimitSample } from '../../../../shared/types/usage';

/**
 * Transcript line -> {@link UsageEvent}. Pure: no filesystem, no clock.
 *
 * Transcript shapes drift between CLI releases, so every field is narrowed
 * from `unknown` and any unrecognised line yields `null` rather than throwing.
 * A malformed line must never abort a scan.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Codex has used both seconds and milliseconds over time.
    return value > 1e12 ? value : value * 1000;
  }
  const raw = asString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Cache-creation tokens are reported either as a flat count or, in newer
 * Claude builds, as a breakdown object keyed by TTL. Sum whatever is there.
 */
function readCacheCreation(usage: Record<string, unknown>): number {
  const flat = asNumber(usage.cache_creation_input_tokens);
  if (flat > 0) return flat;

  const breakdown = usage.cache_creation;
  if (isRecord(breakdown)) {
    return Object.values(breakdown).reduce<number>((sum, entry) => sum + asNumber(entry), 0);
  }
  return 0;
}

function buildEvent(
  provider: UsageProvider,
  usage: Record<string, unknown>,
  meta: { model: string; timestampMs: number; messageId: string | null; agentSessionId: string | null; cwd: string | null }
): UsageEvent | null {
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const cacheReadTokens = asNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = readCacheCreation(usage);

  // A usage object with no tokens at all carries no information.
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) return null;

  return {
    provider,
    timestampMs: meta.timestampMs,
    model: meta.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    agentSessionId: meta.agentSessionId,
    messageId: meta.messageId,
    cwd: meta.cwd,
  };
}

/**
 * Claude Code transcript line.
 *
 * Assistant entries carry `message.usage`; the timestamp, `sessionId` and
 * `cwd` live at the top level.
 */
export function parseClaudeLine(value: unknown, fallbackTimestampMs: number): UsageEvent | null {
  if (!isRecord(value)) return null;
  if (value.type !== 'assistant') return null;

  const message = value.message;
  if (!isRecord(message)) return null;

  const usage = message.usage;
  if (!isRecord(usage)) return null;

  return buildEvent('claude', usage, {
    model: asString(message.model) ?? 'unknown',
    timestampMs: toEpochMs(value.timestamp) ?? fallbackTimestampMs,
    messageId: asString(message.id),
    agentSessionId: asString(value.sessionId),
    cwd: asString(value.cwd),
  });
}

/**
 * Rolling per-file state for the Codex parser.
 *
 * Codex's `token_count` events carry no model, session id or cwd — those
 * arrive earlier in the file on `session_meta` / `turn_context` lines. The
 * scanner threads one context per transcript so each usage event can be
 * attributed correctly.
 */
export interface CodexParseContext {
  model: string | null;
  sessionId: string | null;
  cwd: string | null;
  /** Newest quota state seen in this file, keyed by `${limitId}:${scope}`. */
  rateLimits: Map<string, UsageRateLimitSample>;
}

/**
 * The part of a Codex context that has to outlive a single scan.
 *
 * A transcript is read in pieces as the agent appends to it, and the lines that
 * carry the attribution are at the top — `session_meta` is the file's first
 * line. A pass that resumes at a byte offset never sees them again, so what
 * they said is stored with the file's cursor and handed back in.
 *
 * Quota samples are deliberately not part of this: they live in their own
 * table, and replaying an old sample would move a rolling window backwards.
 */
export interface CodexContextSnapshot {
  model: string | null;
  sessionId: string | null;
  cwd: string | null;
}

export function createCodexContext(seed?: CodexContextSnapshot | null): CodexParseContext {
  return {
    model: seed?.model ?? null,
    sessionId: seed?.sessionId ?? null,
    cwd: seed?.cwd ?? null,
    rateLimits: new Map(),
  };
}

/** What a later pass needs to attribute usage the same way this one did. */
export function snapshotCodexContext(context: CodexParseContext): CodexContextSnapshot {
  return { model: context.model, sessionId: context.sessionId, cwd: context.cwd };
}

/**
 * Pull Codex's self-reported quota state out of a `token_count` event.
 *
 * This is the accurate answer to "how much have I used": the provider states
 * it directly, rather than us inferring it from token sums.
 */
function collectCodexRateLimits(
  payload: Record<string, unknown>,
  capturedAtMs: number,
  context: CodexParseContext
): void {
  const rateLimits = payload.rate_limits;
  if (!isRecord(rateLimits)) return;

  const limitId = asString(rateLimits.limit_id) ?? 'codex';
  const planType = asString(rateLimits.plan_type);

  for (const scope of ['primary', 'secondary'] as const) {
    const entry = rateLimits[scope];
    if (!isRecord(entry)) continue;

    const usedPercent = asNumber(entry.used_percent);
    const windowMinutes = asNumber(entry.window_minutes);
    // `resets_at` is epoch seconds.
    const resetsAt = asNumber(entry.resets_at);

    const sample: UsageRateLimitSample = {
      provider: 'codex',
      limitId,
      scope,
      usedPercent,
      windowMinutes: windowMinutes > 0 ? windowMinutes : null,
      resetsAtMs: resetsAt > 0 ? resetsAt * 1000 : null,
      planType,
      capturedAtMs,
    };

    const key = `${limitId}:${scope}`;
    const existing = context.rateLimits.get(key);
    if (!existing || existing.capturedAtMs <= capturedAtMs) {
      context.rateLimits.set(key, sample);
    }
  }
}

/**
 * Codex transcript line.
 *
 * Real shape, as written by the Codex CLI:
 *
 *   {"type":"event_msg","timestamp":"…","payload":{"type":"token_count",
 *     "info":{"last_token_usage":{input_tokens,cached_input_tokens,
 *       cache_write_input_tokens,output_tokens,reasoning_output_tokens,
 *       total_tokens}, "total_token_usage":{…}}}}
 *
 * **`total_token_usage` is cumulative for the session** — summing it would
 * multiply the real figure many times over. Only `last_token_usage`, the delta
 * for the turn that just finished, may be accumulated.
 *
 * OpenAI reports `input_tokens` inclusive of `cached_input_tokens`, so the
 * cached part is subtracted out to keep the two priced separately.
 */
export function parseCodexLine(
  value: unknown,
  fallbackTimestampMs: number,
  context?: CodexParseContext
): UsageEvent | null {
  if (!isRecord(value)) return null;
  const payload = isRecord(value.payload) ? value.payload : null;

  // Context-carrying lines: remember what later usage events will need.
  if (context) {
    if (value.type === 'session_meta' && payload) {
      context.sessionId = asString(payload.id) ?? context.sessionId;
      context.cwd = asString(payload.cwd) ?? context.cwd;
      context.model = asString(payload.model) ?? context.model;
    } else if ((value.type === 'turn_context' || value.type === 'world_state') && payload) {
      context.model = asString(payload.model) ?? context.model;
      context.cwd = asString(payload.cwd) ?? context.cwd;
    }
  }

  if (value.type !== 'event_msg' || !payload || payload.type !== 'token_count') return null;

  const timestampMs = toEpochMs(value.timestamp) ?? fallbackTimestampMs;
  if (context) collectCodexRateLimits(payload, timestampMs, context);

  const info = isRecord(payload.info) ? payload.info : null;
  const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : null;
  if (!last) return null;

  const cachedInput = asNumber(last.cached_input_tokens);
  const totalInput = asNumber(last.input_tokens);

  const normalized: Record<string, unknown> = {
    // Fresh (uncached) input, so cache reads are not billed twice.
    input_tokens: Math.max(totalInput - cachedInput, 0),
    output_tokens: asNumber(last.output_tokens),
    cache_read_input_tokens: cachedInput,
    cache_creation_input_tokens: asNumber(last.cache_write_input_tokens),
  };

  return buildEvent('codex', normalized, {
    model: context?.model ?? asString(payload.model) ?? 'codex',
    timestampMs,
    // token_count events have no id; the scanner falls back to path:offset.
    messageId: null,
    agentSessionId: context?.sessionId ?? null,
    cwd: context?.cwd ?? null,
  });
}

/**
 * Parse one raw JSONL line for a provider. Returns `null` for blank lines,
 * malformed JSON, and lines that carry no token accounting.
 */
export function parseUsageLine(
  provider: UsageProvider,
  line: string,
  fallbackTimestampMs: number,
  context?: CodexParseContext
): UsageEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  return provider === 'claude'
    ? parseClaudeLine(value, fallbackTimestampMs)
    : parseCodexLine(value, fallbackTimestampMs, context);
}

/**
 * Stable row id. Prefers the provider's message id; falls back to the file
 * offset so re-scanning the same bytes cannot double-count.
 */
export function usageEventId(event: UsageEvent, sourcePath: string, byteOffset: number): string {
  return event.messageId
    ? `${event.provider}:${event.messageId}`
    : `${sourcePath}:${byteOffset}`;
}
