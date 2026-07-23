import { describe, expect, it } from 'vitest';
import { classifyRunpaneInterstitial } from './runpaneInterstitials';

describe('classifyRunpaneInterstitial', () => {
  it('allowlists only the reversible Codex update skip', () => {
    expect(classifyRunpaneInterstitial('Codex update available — Skip', 'codex', 'p1')).toMatchObject({
      disposition: 'allow', response: '2', kind: 'codex-update',
    });
  });

  it('evaluates directory trust before the allowlist', () => {
    expect(classifyRunpaneInterstitial('Codex update available — Skip. Do you trust this directory?', 'codex', 'p1')).toMatchObject({
      disposition: 'deny', blocker: { kind: 'unknown' },
    });
  });

  it.each([
    'Authentication required',
    'Grant permission to continue',
    'This cannot be undone. Continue?',
    'Accept terms of service',
    'Enter payment information',
  ])('denies consequential prompt: %s', (screen) => {
    expect(classifyRunpaneInterstitial(screen, 'codex', 'p1').disposition).toBe('deny');
  });

  it('stops on an unknown planning modal', () => {
    expect(classifyRunpaneInterstitial('Planning suggestion: would you like to switch modes?', 'codex', 'p1').disposition).toBe('unknown');
  });

  it('does not treat a passive MCP authentication banner as an interstitial', () => {
    expect(classifyRunpaneInterstitial('4 MCP servers need authentication\n›', 'claude', 'p1').disposition).toBe('clear');
  });
});
