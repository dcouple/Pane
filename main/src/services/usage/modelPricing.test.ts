import { describe, it, expect } from 'vitest';
import { findModelPrice, estimateCostUsd, MODEL_PRICES, PRICING_AS_OF } from './modelPricing';

describe('findModelPrice', () => {
  it('resolves Claude models', () => {
    expect(findModelPrice('claude-opus-5')?.model).toBe('claude-opus-5');
    expect(findModelPrice('claude-sonnet-5-20260101')?.model).toBe('claude-sonnet-5');
  });

  it('resolves OpenAI and Codex models', () => {
    expect(findModelPrice('gpt-5')?.model).toBe('gpt-5');
    expect(findModelPrice('gpt-5-codex')?.model).toBe('gpt-5-codex');
    expect(findModelPrice('gpt-5.3-codex')?.model).toBe('gpt-5.3-codex');
    expect(findModelPrice('gpt-5.6-terra')?.model).toBe('gpt-5.6-terra');
  });

  it('prefers the longest matching id so variants beat their base model', () => {
    // Every one of these also contains the shorter "gpt-5".
    expect(findModelPrice('gpt-5-mini')?.model).toBe('gpt-5-mini');
    expect(findModelPrice('gpt-5-nano')?.model).toBe('gpt-5-nano');
    expect(findModelPrice('gpt-5-pro')?.model).toBe('gpt-5-pro');
    expect(findModelPrice('gpt-5.4-mini')?.model).toBe('gpt-5.4-mini');
    expect(findModelPrice('gpt-5.5-pro')?.model).toBe('gpt-5.5-pro');
    expect(findModelPrice('gpt-5.1-codex')?.model).toBe('gpt-5.1-codex');
  });

  it('tolerates dated and prefixed ids', () => {
    expect(findModelPrice('gpt-5.3-codex-20260224')?.model).toBe('gpt-5.3-codex');
    expect(findModelPrice('openai/gpt-5-mini')?.model).toBe('gpt-5-mini');
    expect(findModelPrice('GPT-5-CODEX')?.model).toBe('gpt-5-codex');
  });

  it('returns null for unknown or empty models', () => {
    expect(findModelPrice('llama-4-70b')).toBeNull();
    expect(findModelPrice('')).toBeNull();
    // The Codex parser's fallback label is deliberately unpriced.
    expect(findModelPrice('codex')).toBeNull();
  });
});

describe('estimateCostUsd', () => {
  it('prices a Claude request across all four token classes', () => {
    // opus-5: 15 in / 75 out / 1.5 cache-read / 18.75 cache-write per Mtok.
    const { costUsd, complete } = estimateCostUsd({
      model: 'claude-opus-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(complete).toBe(true);
    expect(costUsd).toBeCloseTo(15 + 75 + 1.5 + 18.75, 6);
  });

  it('prices a Codex request', () => {
    const { costUsd, complete } = estimateCostUsd({
      model: 'gpt-5-codex',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(complete).toBe(true);
    expect(costUsd).toBeCloseTo(11.25, 6);
  });

  it('reports incomplete rather than guessing for an unknown model', () => {
    const { costUsd, complete } = estimateCostUsd({
      model: 'mystery-model',
      inputTokens: 5_000_000,
      outputTokens: 5_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(complete).toBe(false);
    expect(costUsd).toBe(0);
  });

  it('returns zero for zero tokens', () => {
    expect(estimateCostUsd({
      model: 'gpt-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }).costUsd).toBe(0);
  });
});

describe('price table integrity', () => {
  it('covers both providers', () => {
    expect(MODEL_PRICES.some(p => p.model.startsWith('claude-'))).toBe(true);
    expect(MODEL_PRICES.some(p => p.model.startsWith('gpt-'))).toBe(true);
  });

  it('has no duplicate model ids', () => {
    const ids = MODEL_PRICES.map(p => p.model);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has non-negative prices and output at least input', () => {
    for (const price of MODEL_PRICES) {
      expect(price.inputPerMTok).toBeGreaterThan(0);
      expect(price.outputPerMTok).toBeGreaterThanOrEqual(price.inputPerMTok);
      expect(price.cacheReadPerMTok).toBeGreaterThanOrEqual(0);
      expect(price.cacheWritePerMTok).toBeGreaterThanOrEqual(0);
    }
  });

  it('carries a parseable as-of date, which the UI footer shows', () => {
    expect(Number.isNaN(Date.parse(PRICING_AS_OF))).toBe(false);
  });
});
