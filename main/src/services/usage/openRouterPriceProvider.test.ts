import { describe, it, expect } from 'vitest';
import {
  normalizeOpenRouterId,
  convertPricing,
  parseOpenRouterResponse,
} from './openRouterPriceProvider';

describe('normalizeOpenRouterId', () => {
  it('strips the vendor prefix', () => {
    expect(normalizeOpenRouterId('anthropic/claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeOpenRouterId('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('passes through ids with no prefix', () => {
    expect(normalizeOpenRouterId('claude-opus-5')).toBe('claude-opus-5');
  });

  it('skips batch variants', () => {
    expect(normalizeOpenRouterId('openai/gpt-5:batch')).toBeNull();
    expect(normalizeOpenRouterId('anthropic/claude-sonnet-5:batch')).toBeNull();
  });

  it('skips fast variants', () => {
    expect(normalizeOpenRouterId('anthropic/claude-opus-5-fast')).toBeNull();
  });

  it('keeps non-fast suffixed models', () => {
    expect(normalizeOpenRouterId('openai/gpt-5.6-luna-pro')).toBe('gpt-5.6-luna-pro');
    expect(normalizeOpenRouterId('openai/gpt-5.1-codex-max')).toBe('gpt-5.1-codex-max');
  });
});

describe('convertPricing', () => {
  it('converts USD-per-token strings to USD-per-MTok numbers', () => {
    const price = convertPricing('claude-opus-5', {
      prompt: '0.000005',
      completion: '0.000025',
      input_cache_read: '0.0000005',
      input_cache_write: '0.00000625',
    });
    expect(price).toEqual({
      model: 'claude-opus-5',
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    });
  });

  it('defaults null cache_read to the input rate', () => {
    const price = convertPricing('gpt-5.5-pro', {
      prompt: '0.00003',
      completion: '0.00018',
      input_cache_read: null,
      input_cache_write: null,
    });
    expect(price?.cacheReadPerMTok).toBe(30);
    expect(price?.cacheWritePerMTok).toBe(30);
  });

  it('defaults missing cache_write to the input rate (OpenAI convention)', () => {
    const price = convertPricing('gpt-5', {
      prompt: '0.00000125',
      completion: '0.00001',
      input_cache_read: '0.000000125',
    });
    expect(price?.cacheWritePerMTok).toBe(1.25);
  });

  it('returns null when prompt pricing is missing', () => {
    expect(convertPricing('x', {})).toBeNull();
    expect(convertPricing('x', { prompt: null, completion: '0.01' })).toBeNull();
    expect(convertPricing('x', undefined)).toBeNull();
  });

  it('handles free models (zero pricing)', () => {
    const price = convertPricing('free-model', {
      prompt: '0',
      completion: '0',
    });
    expect(price?.inputPerMTok).toBe(0);
    expect(price?.outputPerMTok).toBe(0);
  });
});

describe('parseOpenRouterResponse', () => {
  it('parses a realistic response, skipping batch and fast variants', () => {
    const prices = parseOpenRouterResponse({
      data: [
        {
          id: 'anthropic/claude-opus-5',
          pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005', input_cache_write: '0.00000625' },
        },
        {
          id: 'anthropic/claude-opus-5:batch',
          pricing: { prompt: '0.0000025', completion: '0.0000125' },
        },
        {
          id: 'anthropic/claude-opus-5-fast',
          pricing: { prompt: '0.00001', completion: '0.00005' },
        },
        {
          id: 'openai/gpt-5',
          pricing: { prompt: '0.00000125', completion: '0.00001', input_cache_read: '0.000000125' },
        },
      ],
    });

    expect(prices).toHaveLength(2);
    expect(prices[0].model).toBe('claude-opus-5');
    expect(prices[1].model).toBe('gpt-5');
  });

  it('deduplicates by bare id, keeping the first occurrence', () => {
    const prices = parseOpenRouterResponse({
      data: [
        { id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000005', completion: '0.000025' } },
        { id: 'claude-opus-5', pricing: { prompt: '0.000010', completion: '0.000050' } },
      ],
    });

    expect(prices).toHaveLength(1);
    expect(prices[0].inputPerMTok).toBe(5);
  });

  it('skips models with no usable pricing', () => {
    const prices = parseOpenRouterResponse({
      data: [
        { id: 'vendor/good', pricing: { prompt: '0.001', completion: '0.002' } },
        { id: 'vendor/no-pricing' },
        { id: 'vendor/null-pricing', pricing: { prompt: null, completion: null } },
      ],
    });

    expect(prices).toHaveLength(1);
    expect(prices[0].model).toBe('good');
  });
});
