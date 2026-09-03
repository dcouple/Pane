import type { UsageEvent, UsageProvider, UsageRateLimitSample } from '../../../../shared/types/usage';
import { decodeUsageProvider } from '../../../../shared/types/usage';
import {
  boundary,
  decodeBoundary,
  decodeOptionalBoundary,
  type JsonObject,
  type JsonValue,
} from '../../../../shared/validation/boundaryDecoder';

export { decodeUsageProvider };

/**
 * Transcript line -> {@link UsageEvent}. Pure: no filesystem, no clock.
 *
 * Transcript shapes drift between CLI releases, so JSON crosses the shared
 * boundary decoder before fields are read, and unrecognised lines yield null.
 * A malformed line must never abort a scan.
 */

function asObject(value: JsonValue | undefined): JsonObject | null {
  return decodeOptionalBoundary(value, boundary.jsonObject) ?? null;
}

function asNumber(value: JsonValue | undefined): number {
  const number = decodeOptionalBoundary(value, boundary.number);
  return number !== undefined && Number.isFinite(number) ? number : 0;
}

function asString(value: JsonValue | undefined): string | null {
  const string = decodeOptionalBoundary(value, boundary.string);
  return string && string.length > 0 ? string : null;
}

function toEpochMs(value: JsonValue | undefined): number | null {
  const number = decodeOptionalBoundary(value, boundary.number);
  if (number !== undefined && Number.isFinite(number)) {
    // Codex has used both seconds and milliseconds over time.
    return number > 1e12 ? number : number * 1000;
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
function readCacheCreation(usage: JsonObject): number {
  const flat = asNumber(usage.cache_creation_input_tokens);
  if (flat > 0) return flat;

  const breakdown = usage.cache_creation;
  const breakdownObject = asObject(breakdown);
  if (breakdownObject) {
    return Object.values(breakdownObject).reduce<number>((sum, entry) => sum + asNumber(entry), 0);
  }
  return 0;
}

function buildEvent(
  provider: UsageProvider,
  usage: JsonObject,
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
    tokens: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    },
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
export function parseClaudeLine(value: JsonValue, fallbackTimestampMs: number): UsageEvent | null {
  const record = asObject(value);
  if (!record) return null;
  if (record.type !== 'assistant') return null;

  const message = asObject(record.message);
  if (!message) return null;

  const usage = asObject(message.usage);
  if (!usage) return null;

  return buildEvent('claude', usage, {
    model: asString(message.model) ?? 'unknown',
    timestampMs: toEpochMs(record.timestamp) ?? fallbackTimestampMs,
    messageId: asString(message.id),
    agentSessionId: asString(record.sessionId),
    cwd: asString(record.cwd),
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
 * Cursor's transcript lines carry no id, timestamp, tokens or cwd. Identity is
 * fixed for the whole file and comes from outside the lines: the session id is
 * the file's basename, the cwd is the chats sidecar. Both are seeded before
 * the first line is read and never change within a file.
 */
export interface CursorParseContext {
  sessionId: string;
  cwd: string | null;
}

export type CursorContextSnapshot = CursorParseContext;

export const CURSOR_UNKNOWN_MODEL = 'cursor';

/**
 * One event per `{role:"assistant"}` line. `{type:"turn_ended"}` and user
 * lines yield null. Token-shaped keys on the line are ignored: interactive
 * Cursor transcripts do not record measurements.
 */
export function parseCursorLine(
  value: JsonValue,
  fallbackTimestampMs: number,
  context: CursorParseContext
): UsageEvent | null {
  const record = asObject(value);
  if (!record) return null;
  if (record.role !== 'assistant') return null;

  return {
    provider: 'cursor',
    timestampMs: fallbackTimestampMs,
    model: CURSOR_UNKNOWN_MODEL,
    tokens: null,
    agentSessionId: context.sessionId.length > 0 ? context.sessionId : null,
    messageId: null,
    cwd: context.cwd,
  };
}

export type ParseContext =
  | { provider: 'claude' }
  | ({ provider: 'codex' } & CodexParseContext)
  | ({ provider: 'cursor' } & CursorParseContext);

export type ParseContextSnapshot =
  | ({ provider: 'codex' } & CodexContextSnapshot)
  | ({ provider: 'cursor' } & CursorContextSnapshot);

function isTaggedSnapshot(seed: ParseContextSnapshot | CodexContextSnapshot): seed is ParseContextSnapshot {
  return 'provider' in seed;
}

function codexSeedFrom(seed: ParseContextSnapshot | CodexContextSnapshot | null): CodexContextSnapshot | null {
  if (!seed) return null;
  if (isTaggedSnapshot(seed)) {
    return seed.provider === 'codex' ? seed : null;
  }
  return seed;
}

function cursorSeedFrom(seed: ParseContextSnapshot | CodexContextSnapshot | null): CursorContextSnapshot | null {
  if (!seed || !isTaggedSnapshot(seed)) return null;
  return seed.provider === 'cursor' ? seed : null;
}

/** Claude needs nothing. Codex seeds from a prior pass or empty. Cursor MUST be seeded (sessionId is required). */
export function createParseContext(
  provider: UsageProvider,
  seed: ParseContextSnapshot | CodexContextSnapshot | null
): ParseContext {
  if (provider === 'claude') return { provider: 'claude' };
  if (provider === 'cursor') {
    const cursorSeed = cursorSeedFrom(seed);
    return {
      provider: 'cursor',
      sessionId: cursorSeed?.sessionId ?? '',
      cwd: cursorSeed?.cwd ?? null,
    };
  }
  return { provider: 'codex', ...createCodexContext(codexSeedFrom(seed)) };
}

/** Null for Claude; Codex drops rateLimits; Cursor is already a snapshot. */
export function snapshotParseContext(context: ParseContext): ParseContextSnapshot | null {
  if (context.provider === 'claude') return null;
  if (context.provider === 'codex') {
    return { provider: 'codex', ...snapshotCodexContext(context) };
  }
  return { provider: 'cursor', sessionId: context.sessionId, cwd: context.cwd };
}

/** Codex rate limits collected in this pass; [] otherwise. */
export function collectedRateLimits(context: ParseContext): UsageRateLimitSample[] {
  if (context.provider !== 'codex') return [];
  return [...context.rateLimits.values()];
}

/**
 * Pull Codex's self-reported quota state out of a `token_count` event.
 *
 * This is the accurate answer to "how much have I used": the provider states
 * it directly, rather than us inferring it from token sums.
 */
function collectCodexRateLimits(
  payload: JsonObject,
  capturedAtMs: number,
  context: CodexParseContext
): void {
  const rateLimits = payload.rate_limits;
  const rateLimitObject = asObject(rateLimits);
  if (!rateLimitObject) return;

  const limitId = asString(rateLimitObject.limit_id) ?? 'codex';
  const planType = asString(rateLimitObject.plan_type);
  const limitName = asString(rateLimitObject.limit_name);
  const rateLimitReachedType = asString(rateLimitObject.rate_limit_reached_type);
  const spendControlReached = rateLimitObject.spend_control_reached === true ? true
    : rateLimitObject.spend_control_reached === false ? false
    : null;

  const credits = asObject(rateLimitObject.credits);
  const creditsHas = credits?.has_credits === true ? true
    : credits?.has_credits === false ? false
    : null;
  const creditsBalance = credits ? asString(credits.balance) : null;
  const creditsUnlimited = credits?.unlimited === true ? true
    : credits?.unlimited === false ? false
    : null;

  for (const scope of ['primary', 'secondary'] as const) {
    const entry = asObject(rateLimitObject[scope]);
    if (!entry) continue;

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
      creditsHas,
      creditsBalance,
      creditsUnlimited,
      rateLimitReachedType,
      spendControlReached,
      limitName,
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
  value: JsonValue,
  fallbackTimestampMs: number,
  context?: CodexParseContext
): UsageEvent | null {
  const record = asObject(value);
  if (!record) return null;
  const payload = asObject(record.payload);

  // Context-carrying lines: remember what later usage events will need.
  if (context) {
    if (record.type === 'session_meta' && payload) {
      context.sessionId = asString(payload.id) ?? context.sessionId;
      context.cwd = asString(payload.cwd) ?? context.cwd;
      context.model = asString(payload.model) ?? context.model;
    } else if ((record.type === 'turn_context' || record.type === 'world_state') && payload) {
      context.model = asString(payload.model) ?? context.model;
      context.cwd = asString(payload.cwd) ?? context.cwd;
    }
  }

  if (record.type !== 'event_msg' || !payload || payload.type !== 'token_count') return null;

  const timestampMs = toEpochMs(record.timestamp) ?? fallbackTimestampMs;
  if (context) collectCodexRateLimits(payload, timestampMs, context);

  const info = asObject(payload.info);
  const last = asObject(info?.last_token_usage);
  if (!last) return null;

  const cachedInput = asNumber(last.cached_input_tokens);
  const totalInput = asNumber(last.input_tokens);

  const normalized = {
    // Fresh (uncached) input, so cache reads are not billed twice.
    input_tokens: Math.max(totalInput - cachedInput, 0),
    output_tokens: asNumber(last.output_tokens),
    cache_read_input_tokens: cachedInput,
    cache_creation_input_tokens: asNumber(last.cache_write_input_tokens),
  } satisfies JsonObject;

  return buildEvent('codex', normalized, {
    model: context?.model ?? asString(payload.model) ?? 'codex',
    timestampMs,
    // token_count events have no id; the scanner falls back to path:offset.
    messageId: null,
    agentSessionId: context?.sessionId ?? null,
    cwd: context?.cwd ?? null,
  });
}

function asCodexParseContext(
  context: ParseContext | CodexParseContext | CursorParseContext | undefined
): CodexParseContext | undefined {
  if (!context) return undefined;
  if ('rateLimits' in context) return context;
  return undefined;
}

function asCursorParseContext(
  context: ParseContext | CodexParseContext | CursorParseContext | undefined
): CursorParseContext {
  if (context && 'sessionId' in context && typeof context.sessionId === 'string') {
    return { sessionId: context.sessionId, cwd: context.cwd ?? null };
  }
  return { sessionId: '', cwd: null };
}

/**
 * Parse one raw JSONL line for a provider. Returns `null` for blank lines,
 * malformed JSON, and lines that carry no token accounting.
 */
export function parseUsageLine(
  provider: UsageProvider,
  line: string,
  fallbackTimestampMs: number,
  context?: ParseContext | CodexParseContext | CursorParseContext
): UsageEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;

  let value: JsonValue;
  try {
    value = decodeBoundary(JSON.parse(trimmed), boundary.json);
  } catch {
    return null;
  }

  if (provider === 'claude') return parseClaudeLine(value, fallbackTimestampMs);
  if (provider === 'cursor') return parseCursorLine(value, fallbackTimestampMs, asCursorParseContext(context));
  return parseCodexLine(value, fallbackTimestampMs, asCodexParseContext(context));
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
