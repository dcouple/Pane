import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanJsonlFile } from './jsonlScanner';

const FALLBACK_MS = 1_700_000_000_000;

/**
 * Codex names the model, session and cwd once, on the `session_meta` line at
 * the very top of a transcript; its `token_count` events carry none of them.
 * A scan that resumes at a byte offset is past that line for good, so the
 * attribution has to be carried across the pass boundary.
 *
 * Without that, every event after the first pass was filed under model `codex`
 * — which matches no entry in the price table — with no session and no cwd, so
 * its cost went unpriced and the per-project breakdown lost the work entirely.
 * The watcher rescans about every three seconds while an agent is running, so
 * this was the normal case rather than an edge one.
 */
describe('scanJsonlFile carries Codex attribution across passes', () => {
  let dir: string;
  let file: string;

  const meta = (model: string, sessionId: string, cwd: string) => JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-05-01T09:00:00.000Z',
    payload: { id: sessionId, model, cwd },
  });

  const turnContext = (model: string, cwd: string) => JSON.stringify({
    type: 'turn_context',
    timestamp: '2026-05-01T09:30:00.000Z',
    payload: { model, cwd },
  });

  const tokenCount = (inputTokens: number, timestamp: string) => JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: inputTokens, output_tokens: 2 } },
    },
  });

  const assistantLine = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-01T10:00:00.000Z',
    message: { id: 'a', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } },
  });

  /** Everything a usage row is filed under, ignoring where in the file it sat. */
  const attribution = (result: {
    events: Array<{
      event: { model: string; agentSessionId: string | null; cwd: string | null; inputTokens: number };
    }>;
  }) => result.events.map(({ event }) => ({
    model: event.model,
    agentSessionId: event.agentSessionId,
    cwd: event.cwd,
    inputTokens: event.inputTokens,
  }));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pane-usage-codex-'));
    file = join(dir, 'rollout.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reaches the same attribution as a single pass over the finished file', async () => {
    await writeFile(
      file,
      `${meta('gpt-5.1-codex', 'sess-1', '/repo/alpha')}\n${tokenCount(10, '2026-05-01T10:00:00.000Z')}\n`,
      'utf8'
    );

    const first = await scanJsonlFile(file, 'codex', 0, FALLBACK_MS);

    // The agent keeps working: another turn lands, with no context line of its own.
    await appendFile(file, `${tokenCount(20, '2026-05-01T10:05:00.000Z')}\n`, 'utf8');
    const resumed = await scanJsonlFile(file, 'codex', first.nextOffsetBytes, FALLBACK_MS, first.context);

    const incremental = [...attribution(first), ...attribution(resumed)];
    const onePass = attribution(await scanJsonlFile(file, 'codex', 0, FALLBACK_MS));

    expect(incremental).toEqual(onePass);
    expect(incremental).toEqual([
      { model: 'gpt-5.1-codex', agentSessionId: 'sess-1', cwd: '/repo/alpha', inputTokens: 10 },
      { model: 'gpt-5.1-codex', agentSessionId: 'sess-1', cwd: '/repo/alpha', inputTokens: 20 },
    ]);
  });

  it('loses the attribution when the previous pass hands nothing over', async () => {
    await writeFile(
      file,
      `${meta('gpt-5.1-codex', 'sess-1', '/repo/alpha')}\n${tokenCount(10, '2026-05-01T10:00:00.000Z')}\n`,
      'utf8'
    );
    const first = await scanJsonlFile(file, 'codex', 0, FALLBACK_MS);
    await appendFile(file, `${tokenCount(20, '2026-05-01T10:05:00.000Z')}\n`, 'utf8');

    // Exactly what the scanner used to do: a fresh context on every pass.
    const blind = await scanJsonlFile(file, 'codex', first.nextOffsetBytes, FALLBACK_MS);

    expect(attribution(blind)).toEqual([
      { model: 'codex', agentSessionId: null, cwd: null, inputTokens: 20 },
    ]);
  });

  it('hands the next pass what it will need', async () => {
    await writeFile(
      file,
      `${meta('gpt-5.1-codex', 'sess-1', '/repo/alpha')}\n${tokenCount(10, '2026-05-01T10:00:00.000Z')}\n`,
      'utf8'
    );

    const first = await scanJsonlFile(file, 'codex', 0, FALLBACK_MS);

    expect(first.context).toEqual({
      model: 'gpt-5.1-codex',
      sessionId: 'sess-1',
      cwd: '/repo/alpha',
    });
  });

  it('follows a model change that arrives mid-session', async () => {
    await writeFile(
      file,
      `${meta('gpt-5.1-codex', 'sess-1', '/repo/alpha')}\n${tokenCount(10, '2026-05-01T10:00:00.000Z')}\n`,
      'utf8'
    );
    const first = await scanJsonlFile(file, 'codex', 0, FALLBACK_MS);

    await appendFile(
      file,
      `${turnContext('gpt-5.3-codex', '/repo/beta')}\n${tokenCount(30, '2026-05-01T11:00:00.000Z')}\n`,
      'utf8'
    );
    const second = await scanJsonlFile(file, 'codex', first.nextOffsetBytes, FALLBACK_MS, first.context);

    expect(attribution(second)).toEqual([
      { model: 'gpt-5.3-codex', agentSessionId: 'sess-1', cwd: '/repo/beta', inputTokens: 30 },
    ]);
    // The session id, which only session_meta ever states, is still carried.
    expect(second.context).toEqual({
      model: 'gpt-5.3-codex',
      sessionId: 'sess-1',
      cwd: '/repo/beta',
    });
  });

  it('lets the file overrule a stale seed when it is read from the top again', async () => {
    await writeFile(
      file,
      `${meta('gpt-5.1-codex', 'sess-new', '/repo/alpha')}\n${tokenCount(10, '2026-05-01T10:00:00.000Z')}\n`,
      'utf8'
    );

    // What a rotated file's stored cursor would have offered.
    const stale = { model: 'gpt-5-codex', sessionId: 'sess-old', cwd: '/repo/gone' };
    const result = await scanJsonlFile(file, 'codex', 0, FALLBACK_MS, stale);

    expect(attribution(result)).toEqual([
      { model: 'gpt-5.1-codex', agentSessionId: 'sess-new', cwd: '/repo/alpha', inputTokens: 10 },
    ]);
  });

  it('reports no context for Claude, whose lines each carry their own', async () => {
    await writeFile(file, `${assistantLine}\n`, 'utf8');
    const result = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);
    expect(result.context).toBeNull();
  });

  it('does not replay quota samples the seed was never meant to hold', async () => {
    const withLimits = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-05-01T10:00:00.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } },
        rate_limits: { limit_id: 'codex', primary: { used_percent: 42, window_minutes: 300 } },
      },
    });
    await writeFile(file, `${meta('gpt-5.1-codex', 'sess-1', '/repo/alpha')}\n${withLimits}\n`, 'utf8');
    const first = await scanJsonlFile(file, 'codex', 0, FALLBACK_MS);
    expect(first.rateLimits).toHaveLength(1);

    await appendFile(file, `${tokenCount(20, '2026-05-01T10:05:00.000Z')}\n`, 'utf8');
    const resumed = await scanJsonlFile(file, 'codex', first.nextOffsetBytes, FALLBACK_MS, first.context);

    // A quota reading belongs to the moment it was taken and lives in its own
    // table; carrying it forward would keep re-announcing a stale number.
    expect(resumed.rateLimits).toEqual([]);
  });
});
